import {
  Calendar,
  File,
  FileImage,
  FileText,
  FileSpreadsheet,
  FileArchive,
  FileAudio,
  FileVideo,
} from "lucide-react";

export function getFileIcon(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext)) {
    return FileImage;
  }
  if (["pdf", "doc", "docx", "txt", "rtf", "odt"].includes(ext)) {
    return FileText;
  }
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) {
    return FileSpreadsheet;
  }
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) {
    return FileArchive;
  }
  if (["mp3", "wav", "ogg", "flac", "aac"].includes(ext)) {
    return FileAudio;
  }
  if (["mp4", "avi", "mov", "mkv", "webm"].includes(ext)) {
    return FileVideo;
  }
  if (["ics", "ical", "ifb"].includes(ext)) {
    return Calendar;
  }

  return File;
}

export function isImageFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext);
}
