import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client } from "@/config/s3";

const BUCKET_NAME = process.env.S3_BUCKET_NAME || "amigo-profile-images";

// S3 folder structure
export const S3_FOLDERS = {
  IMAGES: "images",
  AUDIOS: "audios",
  VIDEOS: "videos",
  DOCS: "docs",
  PROFILE_IMAGES: "profile-images"
} as const;

// File type mappings
export const FILE_TYPE_MAPPINGS = {

  // Images
  "image/jpeg": S3_FOLDERS.IMAGES,
  "image/jpg": S3_FOLDERS.IMAGES,
  "image/png": S3_FOLDERS.IMAGES,
  "image/webp": S3_FOLDERS.IMAGES,
  "image/gif": S3_FOLDERS.IMAGES,
  "image/heif": S3_FOLDERS.IMAGES,
  "image/heic": S3_FOLDERS.IMAGES,
  "image/svg+xml": S3_FOLDERS.IMAGES,

  // Audio files
  "audio/mpeg": S3_FOLDERS.AUDIOS,
  "audio/mp3": S3_FOLDERS.AUDIOS,
  "audio/wav": S3_FOLDERS.AUDIOS,
  "audio/x-wav": S3_FOLDERS.AUDIOS,
  "audio/ogg": S3_FOLDERS.AUDIOS,
  "audio/aac": S3_FOLDERS.AUDIOS,
  "audio/x-m4a": S3_FOLDERS.AUDIOS,
  "audio/flac": S3_FOLDERS.AUDIOS,

  // Video files
  "video/mp4": S3_FOLDERS.VIDEOS,
  "video/avi": S3_FOLDERS.VIDEOS,
  "video/mov": S3_FOLDERS.VIDEOS,
  "video/wmv": S3_FOLDERS.VIDEOS,
  "video/flv": S3_FOLDERS.VIDEOS,
  "video/webm": S3_FOLDERS.VIDEOS,
  "video/mkv": S3_FOLDERS.VIDEOS,
  "video/h.265": S3_FOLDERS.VIDEOS,

  // Document files
  "application/pdf": S3_FOLDERS.DOCS,
  "application/msword": S3_FOLDERS.DOCS,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": S3_FOLDERS.DOCS,
  "application/vnd.ms-excel": S3_FOLDERS.DOCS,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": S3_FOLDERS.DOCS,
  "application/vnd.ms-powerpoint": S3_FOLDERS.DOCS,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": S3_FOLDERS.DOCS,
  "text/plain": S3_FOLDERS.DOCS,
  "text/csv": S3_FOLDERS.DOCS,
  "application/rtf": S3_FOLDERS.DOCS,
  "application/zip": S3_FOLDERS.DOCS,
  "application/x-rar-compressed": S3_FOLDERS.DOCS,
  "application/x-7z-compressed": S3_FOLDERS.DOCS,

} as const;

export type FileType = keyof typeof FILE_TYPE_MAPPINGS;
export type S3Folder = typeof S3_FOLDERS[keyof typeof S3_FOLDERS];

// Helper function to determine file category
export const get_file_category = (mimeType: string): S3Folder | null => {
  return FILE_TYPE_MAPPINGS[mimeType as FileType] || null;
};

// Helper function to validate file type
export const is_valid_file_type = (mimeType: string): boolean => {
  return mimeType in FILE_TYPE_MAPPINGS;
};

// Generic file upload function
export const upload_file_to_s3 = async (
  file: File,
  key: string,
  folder?: S3Folder
): Promise<{ success: boolean; url?: string; error?: string; key?: string }> => {
  try {
    // Validate file type
    if (!is_valid_file_type(file.type)) {
      return {
        success: false,
        error: `Unsupported file type: ${file.type}`,
      };
    }

    // Determine folder if not provided
    const targetFolder = folder || get_file_category(file.type);
    if (!targetFolder) {
      return {
        success: false,
        error: "Unable to determine target folder for file type",
      };
    }

    // Create full key with folder structure
    const fullKey = `${targetFolder}/${key}`;

    const buffer = await file.arrayBuffer();

    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: fullKey,
      Body: new Uint8Array(buffer),
      ContentType: file.type,
      ACL: "public-read" as const,
    };

    const command = new PutObjectCommand(uploadParams);
    await s3Client.send(command);

    const fileUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || "ap-south-1"}.amazonaws.com/${fullKey}`;

    return {
      success: true,
      url: fileUrl,
      key: fullKey,
    };
  } catch (error: any) {
    console.error("Error uploading to S3:", error);
    return {
      success: false,
      error: error.message || "Failed to upload file",
    };
  }
};

// Backward compatibility - specific image upload function
export const upload_image_to_s3 = async (
  file: File,
  key: string
): Promise<{ success: boolean; url?: string; error?: string }> => {
  const result = await upload_file_to_s3(file, key, S3_FOLDERS.PROFILE_IMAGES);
  return {
    success: result.success,
    url: result.url,
    error: result.error,
  };
};

export const delete_image_from_s3 = async (key: string): Promise<{ success: boolean; error?: string }> => {
  try {
    const deleteParams = {
      Bucket: BUCKET_NAME,
      Key: key,
    };

    const command = new DeleteObjectCommand(deleteParams);
    await s3Client.send(command);

    return { success: true };
  } catch (error: any) {
    console.error("Error deleting from S3:", error);
    return {
      success: false,
      error: error.message || "Failed to delete image",
    };
  }
};

export const get_presigned_url = async (
  key: string,
  expiresIn: number = 3600
): Promise<{ success: boolean; url?: string; error?: string }> => {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn });

    return {
      success: true,
      url,
    };
  } catch (error: any) {
    console.error("Error generating presigned URL:", error);
    return {
      success: false,
      error: error.message || "Failed to generate presigned URL",
    };
  }
};

// Generate unique file key based on user ID and file type
export const generate_file_key = (
  userId: number,
  fileName: string,
  fileType?: S3Folder
): string => {
  const timestamp = Date.now();
  const extension = fileName.split('.').pop() || 'unknown';
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');

  if (fileType) {
    return `${userId}/${timestamp}_${sanitizedFileName}`;
  }

  return `${userId}/${timestamp}_${sanitizedFileName}`;
};

// Backward compatibility for profile images
export const generate_profile_image_key = (userId: number, fileName: string): string => {
  return generate_file_key(userId, fileName, S3_FOLDERS.PROFILE_IMAGES);
};

// Get file size limits based on file type
export const get_file_size_limit = (mimeType: string): number => {
  const category = get_file_category(mimeType);

  switch (category) {
    case S3_FOLDERS.IMAGES:
    case S3_FOLDERS.PROFILE_IMAGES:
      return 5 * 1024 * 1024; // 5MB for images
    case S3_FOLDERS.AUDIOS:
      return 50 * 1024 * 1024; // 50MB for audio
    case S3_FOLDERS.VIDEOS:
      return 500 * 1024 * 1024; // 500MB for videos
    case S3_FOLDERS.DOCS:
      return 25 * 1024 * 1024; // 25MB for documents
    default:
      return 5 * 1024 * 1024; // Default 5MB
  }
};

// Get allowed file types for each category
export const get_allowed_file_types = (category: S3Folder): string[] => {
  return Object.keys(FILE_TYPE_MAPPINGS).filter(
    type => FILE_TYPE_MAPPINGS[type as FileType] === category
  );
};
