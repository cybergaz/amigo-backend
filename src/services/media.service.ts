import { 
  upload_file_to_s3, 
  delete_image_from_s3, 
  generate_file_key, 
  get_file_size_limit,
  is_valid_file_type,
  get_file_category,
  S3_FOLDERS,
  type S3Folder 
} from "@/services/s3.service";

export const upload_media_file = async (
  userId: number,
  file: File,
  category?: S3Folder
) => {
  try {
    // Validate file type
    if (!is_valid_file_type(file.type)) {
      return {
        success: false,
        code: 400,
        message: `Unsupported file type: ${file.type}`,
        data: null,
      };
    }

    // Get file category if not provided
    const targetCategory = category || get_file_category(file.type);
    if (!targetCategory) {
      return {
        success: false,
        code: 400,
        message: "Unable to determine file category",
        data: null,
      };
    }

    // Validate file size
    const maxSize = get_file_size_limit(file.type);
    if (file.size > maxSize) {
      const maxSizeMB = Math.round(maxSize / (1024 * 1024));
      return {
        success: false,
        code: 400,
        message: `File size too large. Maximum size is ${maxSizeMB}MB for ${targetCategory}.`,
        data: null,
      };
    }

    // Generate file key
    const fileKey = generate_file_key(userId, file.name);

    // Upload to S3
    const uploadResult = await upload_file_to_s3(file, fileKey, targetCategory);
    if (!uploadResult.success) {
      return {
        success: false,
        code: 500,
        message: uploadResult.error || "Failed to upload file",
        data: null,
      };
    }

    return {
      success: true,
      code: 200,
      message: "File uploaded successfully",
      data: {
        url: uploadResult.url,
        key: uploadResult.key,
        category: targetCategory,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
      },
    };
  } catch (error: any) {
    console.error("Error uploading media file:", error);
    return {
      success: false,
      code: 500,
      message: "Failed to upload file",
      data: null,
    };
  }
};

export const delete_media_file = async (key: string) => {
  try {
    const deleteResult = await delete_image_from_s3(key);
    if (!deleteResult.success) {
      return {
        success: false,
        code: 500,
        message: deleteResult.error || "Failed to delete file",
      };
    }

    return {
      success: true,
      code: 200,
      message: "File deleted successfully",
    };
  } catch (error: any) {
    console.error("Error deleting media file:", error);
    return {
      success: false,
      code: 500,
      message: "Failed to delete file",
    };
  }
};

// Specific upload functions for different media types
export const upload_image = (userId: number, file: File) => 
  upload_media_file(userId, file, S3_FOLDERS.IMAGES);

export const upload_audio = (userId: number, file: File) => 
  upload_media_file(userId, file, S3_FOLDERS.AUDIOS);

export const upload_video = (userId: number, file: File) => 
  upload_media_file(userId, file, S3_FOLDERS.VIDEOS);

export const upload_document = (userId: number, file: File) => 
  upload_media_file(userId, file, S3_FOLDERS.DOCS);
