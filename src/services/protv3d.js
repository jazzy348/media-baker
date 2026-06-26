function detectProTv3d(mediaFile, library) {
  const text = detectionText(mediaFile);
  const mode = filenameMode(text);
  if (mode) {
    return {
      enabled: true,
      mode,
      source: "filename"
    };
  }

  if (library && library.threeD) {
    return {
      enabled: true,
      mode: "1",
      source: "library"
    };
  }

  return {
    enabled: false,
    mode: null,
    source: null
  };
}

function detectionText(mediaFile) {
  return [
    mediaFile && mediaFile.filename,
    mediaFile && mediaFile.title,
    mediaFile && mediaFile.folder,
    mediaFile && mediaFile.showName,
    mediaFile && mediaFile.filePath
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filenameMode(text) {
  if (!has3dHint(text)) {
    return null;
  }

  if (isSideBySide(text)) {
    return isSwapped(text) ? "2" : "1";
  }

  if (isOverUnder(text)) {
    return isSwapped(text) ? "4" : "3";
  }

  return "1";
}

function has3dHint(text) {
  return /(^|[^a-z0-9])(3d|3-d|sbs|hsbs|h-sbs|side[ ._-]*by[ ._-]*side|ou|hou|h-ou|over[ ._-]*under|top[ ._-]*bottom|tab|mvc)([^a-z0-9]|$)/i.test(text);
}

function isSideBySide(text) {
  return /(^|[^a-z0-9])(sbs|hsbs|h-sbs|side[ ._-]*by[ ._-]*side|sidebyside|left[ ._-]*right)([^a-z0-9]|$)/i.test(text);
}

function isOverUnder(text) {
  return /(^|[^a-z0-9])(ou|hou|h-ou|over[ ._-]*under|overunder|top[ ._-]*bottom|topbottom|tab)([^a-z0-9]|$)/i.test(text);
}

function isSwapped(text) {
  return /(^|[^a-z0-9])(swapped|swap|rl|right[ ._-]*left|right[ ._-]*first|bottom[ ._-]*top|bottom[ ._-]*first)([^a-z0-9]|$)/i.test(text);
}

module.exports = { detectProTv3d };
