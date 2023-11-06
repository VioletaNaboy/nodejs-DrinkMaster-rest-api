const cloudinary = require("cloudinary").v2;

const deletePhoto = async (file, id) => {
  try {
    const result = await cloudinary.api.delete_resources([`${file}/${id}`], {
      type: "upload",
      resource_type: "image",
    });

    return result.deleted_counts;
  } catch (error) {
    console.log(error.mesage, "\n", `/Not found photo by ${id}`);
  }
};

module.exports = deletePhoto;
