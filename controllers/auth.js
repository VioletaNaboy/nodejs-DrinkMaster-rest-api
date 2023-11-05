const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const querystring = require("node:querystring");
const URL = require("url");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;

const { User } = require("../models/user");
const { sessionModel } = require("../models/session");
const { HttpError, ctrlWrapper } = require("../utils");

const {
  ACCESS_SECRET_JWT,
  REFRESH_SECRET_JWT,
  BASE_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
} = process.env;

const register = async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });

  if (user) {
    throw HttpError(409, "Email in use");
  }

  const hashPassword = await bcrypt.hash(password, 10);

  const avatar = await cloudinary.api.resource_by_asset_id(
    "7e0d1d99eb7335d69d04597fb62b082e"
  );

  let avatarURL = "";

  if (avatar) {
    avatarURL = avatar.url;
  }

  const newUser = await User.create({
    ...req.body,
    password: hashPassword,
    avatarURL,
  });

  const newSession = await sessionModel.create({
    uid: newUser._id,
  });

  const payload = { uid: newUser._id, sid: newSession._id };

  const accessToken = jwt.sign(payload, ACCESS_SECRET_JWT, {
    expiresIn: "12h",
  });
  const refreshToken = jwt.sign(payload, REFRESH_SECRET_JWT, {
    expiresIn: "7d",
  });
  await User.findByIdAndUpdate(newUser._id, {
    accessToken,
    refreshToken,
    sid: newSession._id,
  });
  res.status(201).json({
    accessToken,
    refreshToken,
    sid: newSession._id,
    user: {
      name: newUser.name,
      email: newUser.email,
      birthday: newUser.birthday,
    },
  });
};

const login = async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });

  if (!user) {
    throw HttpError(401, "Email or password is wrong");
  }

  const passwordCompare = await bcrypt.compare(password, user.password);

  if (passwordCompare === false) {
    throw HttpError(401, "Email or password is wrong");
  }

  const newSession = await sessionModel.create({
    uid: user._id,
  });

  const payload = { uid: user._id, sid: newSession._id };

  const accessToken = jwt.sign(payload, ACCESS_SECRET_JWT, {
    expiresIn: "12h",
  });
  const refreshToken = jwt.sign(payload, REFRESH_SECRET_JWT, {
    expiresIn: "7d",
  });

  const { name, birthday } = user;

  await User.findByIdAndUpdate(user._id, {
    accessToken: accessToken,
    refreshToken: refreshToken,
    sid: newSession._id,
  });

  res.json({
    accessToken: accessToken,
    refreshToken: refreshToken,
    sid: newSession._id,
    user: {
      email,
      name,
      birthday,
    },
  });
};

const refreshTokens = async (req, res) => {
  const authorizationHeader = req.get("Authorization");
  if (authorizationHeader) {
    const activeSession = await sessionModel.findById(req.body.sid);
    if (!activeSession) {
      throw HttpError(404, "Invalid session");
    }
    const reqRefreshToken = authorizationHeader.replace("Bearer ", "");
    let payload = {};
    try {
      payload = jwt.verify(reqRefreshToken, REFRESH_SECRET_JWT);
    } catch (err) {
      await sessionModel.findByIdAndDelete(req.body.sid);
      throw HttpError(401, "Unauthorized");
    }
    const user = await User.findById(payload.uid);
    const session = await sessionModel.findById(payload.sid);
    console.log(session);
    if (!user) {
      throw HttpError(404, "Invalid user");
    }
    if (!session) {
      throw HttpError(404, "Invalid session");
    }
    await sessionModel.findByIdAndDelete(payload.sid);
    const newSession = await sessionModel.create({
      uid: user._id,
    });
    const newAccessToken = jwt.sign(
      { uid: user._id, sid: newSession._id },
      ACCESS_SECRET_JWT,
      {
        expiresIn: "12h",
      }
    );
    const newRefreshToken = jwt.sign(
      { uid: user._id, sid: newSession._id },
      REFRESH_SECRET_JWT,
      { expiresIn: "7d" }
    );
    return res
      .status(200)
      .send({ newAccessToken, newRefreshToken, newSid: newSession._id });
  }
  throw HttpError(400, "No token provided");
};

const signout = async (req, res) => {
  const currentSession = req.session;
  const { id } = req.user;
  console.log(id);
  await User.findByIdAndUpdate(id, { accessToken: "", refreshToken: "" });
  await sessionModel.deleteOne({ _id: currentSession._id });
  return res.status(204).end();
};

const googleAuth = async (req, res) => {
  const stringifiedParams = querystring.stringify({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/google-redirect`,
    scope: [
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ].join(" "),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
  });
  return res.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${stringifiedParams}`
  );
};

const googleRedirect = async (req, res) => {
  const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const urlObj = new URL(fullUrl);
  const urlParams = querystring.parse(urlObj.search);
  const code = urlParams.code;
  console.log(code);
  const tokenData = await axios({
    url: `https://oauth2.googleapis.com/token`,
    method: "post",
    data: {
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: `${BASE_URL}/auth/google-redirect`,
      grant_type: "authorization_code",
      code,
    },
  });
  const userData = await axios({
    url: "https://www.googleapis.com/oauth2/v2/userinfo",
    method: "get",
    headers: {
      Authorization: "Bearer"`${tokenData.data.access_token}`,
    },
  });
  console.log(userData);
  const existingParent = await User.findOne({ email: userData.data.email });
  if (!existingParent || !existingParent.originUrl) {
    return res.status(403).send({
      message:
        "You should register from front-end first (not postman). Google/Facebook are only for sign-in",
    });
  }
  const newSession = await sessionModel.create({
    uid: existingParent._id,
  });
  const accessToken = jwt.sign(
    { uid: existingParent._id, sid: newSession._id },
    ACCESS_SECRET_JWT,
    {
      expiresIn: "12h",
    }
  );
  const refreshToken = jwt.sign(
    { uid: existingParent._id, sid: newSession._id },
    REFRESH_SECRET_JWT,
    {
      expiresIn: "7d",
    }
  );
  return res.redirect` ${existingParent.originUrl}?accessToken=${accessToken}&refreshToken=${refreshToken}&sid=${newSession._id}`();
};

module.exports = {
  register: ctrlWrapper(register),
  login: ctrlWrapper(login),
  refreshTokens: ctrlWrapper(refreshTokens),
  signout: ctrlWrapper(signout),
  googleAuth: ctrlWrapper(googleAuth),
  googleRedirect: ctrlWrapper(googleRedirect),
};
