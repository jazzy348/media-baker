(function exposeNavigation(global) {
  function readRoute() {
    const url = new URL(global.location.href);
    const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);

    if (segments.length === 0) {
      return { name: "home", mode: url.searchParams.get("mode") === "random" ? "random" : "recent" };
    }
    if (segments[0] === "search") {
      return { name: "search", query: url.searchParams.get("q") || "" };
    }
    if (segments[0] === "history" && segments.length === 1) {
      return { name: "history" };
    }
    if (segments[0] === "live-tv" && segments.length === 1) {
      const start = url.searchParams.get("start");
      return { name: "live-tv", start: start ? new Date(start) : new Date(), pinnedToNow: !start };
    }
    if (segments[0] === "libraries" && segments[1]) {
      if (segments[2] === "artists" && segments[3] && segments[4] === "albums" && segments[5]) {
        return { name: "album", libraryKey: segments[1], artistId: segments[3], albumId: segments[5] };
      }
      if (segments[2] === "artists" && segments[3]) {
        return { name: "artist", libraryKey: segments[1], artistId: segments[3] };
      }
      if (segments[2] === "shows" && segments[3] && segments[4] === "seasons" && segments[5]) {
        return {
          name: "season",
          libraryKey: segments[1],
          showId: segments[3],
          season: Number(segments[5])
        };
      }
      if (segments[2] === "shows" && segments[3]) {
        return { name: "show", libraryKey: segments[1], showId: segments[3] };
      }
      if (segments.length === 2) {
        return {
          name: "library",
          libraryKey: segments[1],
          folder: url.searchParams.get("folder") || "",
          title: global.history.state && global.history.state.title || ""
        };
      }
    }

    return { name: "not-found" };
  }

  function navigate(path, options = {}) {
    const next = new URL(path, global.location.origin);
    const current = new URL(global.location.href);
    const shareToken = current.searchParams.get("shareToken");
    if (shareToken && !next.searchParams.has("shareToken")) {
      next.searchParams.set("shareToken", shareToken);
    }

    const target = `${next.pathname}${next.search}${next.hash}`;
    const currentTarget = `${current.pathname}${current.search}${current.hash}`;
    if (target === currentTarget) {
      if (options.state) {
        global.history.replaceState(options.state, "", target);
      }
      return;
    }

    const method = options.replace ? "replaceState" : "pushState";
    global.history[method](options.state || null, "", target);
  }

  function onChange(handler) {
    global.addEventListener("popstate", () => handler(readRoute()));
  }

  function homePath(mode = "recent") {
    return mode === "random" ? "/?mode=random" : "/";
  }

  function searchPath(query) {
    return `/search?q=${encodeURIComponent(query)}`;
  }

  function libraryPath(libraryKey, folder = "") {
    const base = `/libraries/${encodeURIComponent(libraryKey)}`;
    return folder ? `${base}?folder=${encodeURIComponent(folder)}` : base;
  }

  function showPath(libraryKey, showId) {
    return `${libraryPath(libraryKey)}/shows/${encodeURIComponent(showId)}`;
  }

  function seasonPath(libraryKey, showId, season) {
    return `${showPath(libraryKey, showId)}/seasons/${encodeURIComponent(season)}`;
  }

  function liveTvPath(start, pinnedToNow) {
    return pinnedToNow ? "/live-tv" : `/live-tv?start=${encodeURIComponent(start.toISOString())}`;
  }

  function artistPath(libraryKey, artistId) {
    return `${libraryPath(libraryKey)}/artists/${encodeURIComponent(artistId)}`;
  }

  function albumPath(libraryKey, artistId, albumId) {
    return `${artistPath(libraryKey, artistId)}/albums/${encodeURIComponent(albumId)}`;
  }

  function decodeSegment(value) {
    try {
      return decodeURIComponent(value);
    } catch (err) {
      return value;
    }
  }

  global.MediaBakerNavigation = Object.freeze({
    readRoute,
    navigate,
    onChange,
    homePath,
    searchPath,
    libraryPath,
    showPath,
    seasonPath,
    artistPath,
    albumPath,
    liveTvPath
  });
})(window);
