const express = require("express");

module.exports = function createDocsRoutes() {
  const router = express.Router();
  const spec = openApiSpec();

  router.get("/", (req, res) => {
    res.type("html").send(swaggerHtml());
  });

  router.get("/openapi.json", (req, res) => {
    res.json(spec);
  });

  return router;
};

function openApiSpec() {
  return {
    openapi: "3.0.3",
    info: {
      title: "Media Baker API",
      version: "1.0.0",
      description: "API for indexing media libraries, managing users/libraries, fetching metadata, tracking playback, and serving HLS streams."
    },
    tags: [
      { name: "Auth" },
      { name: "Admin" },
      { name: "Catalog" },
      { name: "Libraries" },
      { name: "Playback Progress" },
      { name: "Streams" },
      { name: "Health" }
    ],
    components: {
      securitySchemes: {
        SessionToken: {
          type: "apiKey",
          in: "header",
          name: "X-Session-Token"
        },
        BearerAuth: {
          type: "http",
          scheme: "bearer"
        },
        ApiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key"
        },
        ShareToken: {
          type: "apiKey",
          in: "header",
          name: "X-Share-Token"
        },
        PlaybackToken: {
          type: "apiKey",
          in: "query",
          name: "playbackToken"
        }
      },
      schemas: {
        Error: objectSchema({ error: { type: "string" } }),
        LibraryInput: objectSchema({
          title: { type: "string", example: "Weeb TV" },
          type: { type: "string", enum: ["tv", "movies", "tv-3d", "movies-3d"] },
          path: { type: "string", example: "/media/anime/shows" }
        }),
        SettingsRequest: objectSchema({
          settings: { type: "object", additionalProperties: true }
        })
      }
    },
    security: [{ SessionToken: [] }, { BearerAuth: [] }, { ApiKey: [] }, { ShareToken: [] }],
    paths: {
      "/api/auth/status": {
        get: operation("Auth", "Check first-run setup status", "Returns whether an admin account must be created.", false)
      },
      "/api/auth/setup": {
        post: operation("Auth", "Create first admin account", "Only works when no accounts exist.", false, {
          requestBody: jsonBody(objectSchema({
            username: { type: "string" },
            password: { type: "string", format: "password" }
          }))
        })
      },
      "/api/auth/login": {
        post: operation("Auth", "Login", "Returns a session token for username/password credentials.", false, {
          requestBody: jsonBody(objectSchema({
            username: { type: "string" },
            password: { type: "string", format: "password" }
          }))
        })
      },
      "/api/auth/me": {
        get: operation("Auth", "Current account", "Returns the authenticated account.")
      },
      "/api/health": {
        get: operation("Health", "Health check", "Returns index counts, scan state, and FFmpeg availability.")
      },
      "/api/admin/accounts": {
        get: operation("Admin", "List accounts", "Requires user-management permission."),
        post: operation("Admin", "Create account", "Requires user-management permission.", true, {
          requestBody: jsonBody(objectSchema({
            username: { type: "string" },
            password: { type: "string", format: "password" },
            permissions: { type: "object", additionalProperties: true },
            libraryKeys: { type: "array", items: { type: "string" } }
          }))
        })
      },
      "/api/admin/accounts/{id}": {
        put: operation("Admin", "Update account", "Edits username, password, permissions, or library access.", true, {
          parameters: [pathParam("id")],
          requestBody: jsonBody(objectSchema({
            username: { type: "string" },
            password: { type: "string", format: "password" },
            permissions: { type: "object", additionalProperties: true },
            libraryKeys: { type: "array", items: { type: "string" } }
          }))
        }),
        delete: operation("Admin", "Delete account", "Requires user-management permission.", true, {
          parameters: [pathParam("id")]
        })
      },
      "/api/admin/api-keys": {
        get: operation("Admin", "List API keys", "Requires API-key-management permission."),
        post: operation("Admin", "Create API key", "Returns the raw API key once.", true, {
          requestBody: jsonBody(objectSchema({
            userId: { type: "string" },
            name: { type: "string", example: "Automation" }
          }))
        })
      },
      "/api/admin/api-keys/{id}": {
        delete: operation("Admin", "Revoke API key", "Requires API-key-management permission.", true, {
          parameters: [pathParam("id")]
        })
      },
      "/api/admin/settings": {
        get: operation("Admin", "Get runtime settings", "Requires settings-management permission."),
        put: operation("Admin", "Update runtime settings", "Applies supported settings without restarting.", true, {
          requestBody: jsonBody({ $ref: "#/components/schemas/SettingsRequest" })
        })
      },
      "/api/admin/hardware": {
        get: operation("Admin", "Hardware usage", "Returns CPU, memory, GPU, and network samples.")
      },
      "/api/admin/logs": {
        get: operation("Admin", "Recent logs", "Returns recent in-memory app log entries.", true, {
          parameters: [queryParam("limit", "integer")]
        })
      },
      "/api/admin/currently-playing": {
        get: operation("Admin", "Currently playing", "Lists users with recent HLS segment activity.")
      },
      "/api/admin/history": {
        get: operation("Admin", "User watch history", "Lists watched and in-progress items by user.")
      },
      "/api/admin/duplicates": {
        get: operation("Admin", "Duplicate files", "Lists likely duplicates from matched metadata.", true, {
          parameters: [queryParam("limit", "integer")]
        })
      },
      "/api/admin/folders": {
        get: operation("Admin", "Browse folders", "Lists child folders for the library picker.", true, {
          parameters: [queryParam("path")]
        })
      },
      "/api/admin/reindex": {
        post: operation("Admin", "Re-index all libraries", "Starts a background rebuild.")
      },
      "/api/catalog/home": {
        get: operation("Catalog", "Home rows", "Returns recent or random media rows.", true, {
          parameters: [queryParam("mode", "string", ["recent", "random"])]
        })
      },
      "/api/catalog/search": {
        get: operation("Catalog", "Search catalog", "Searches metadata names and episode numbers.", true, {
          parameters: [queryParam("q")]
        })
      },
      "/api/catalog/libraries/{libraryKey}/items": {
        get: operation("Catalog", "Lazy-load library items", "Lists shows or movies for one library.", true, {
          parameters: [
            pathParam("libraryKey"),
            queryParam("offset", "integer"),
            queryParam("limit", "integer"),
            queryParam("sort", "string", ["alpha", "recent"]),
            queryParam("metadata", "string", ["all", "unmatched"])
          ]
        })
      },
      "/api/catalog/{mediaType}/{id}/options": {
        get: operation("Catalog", "Fresh stream options", "Probes a file and returns audio, subtitle, and quality choices.", true, {
          parameters: [pathParam("mediaType"), pathParam("id")]
        })
      },
      "/api/catalog/{mediaType}/{id}/metadata": {
        get: operation("Catalog", "Get metadata", "Returns cached metadata and fetches on demand when enabled.", true, {
          parameters: [pathParam("mediaType"), pathParam("id")]
        })
      },
      "/api/catalog/{mediaType}/{id}/metadata/refresh": {
        post: operation("Catalog", "Refresh metadata match", "Re-runs provider matching for one item.", true, {
          parameters: [pathParam("mediaType"), pathParam("id")]
        })
      },
      "/api/catalog/{mediaType}/{id}/metadata/search": {
        get: operation("Catalog", "Search metadata candidates", "Returns TMDb candidates for manual matching.", true, {
          parameters: [pathParam("mediaType"), pathParam("id"), queryParam("title"), queryParam("year", "integer")]
        })
      },
      "/api/catalog/{mediaType}/{id}/metadata/match": {
        post: operation("Catalog", "Apply metadata provider ID", "Manually matches one item or show.", true, {
          parameters: [pathParam("mediaType"), pathParam("id")],
          requestBody: jsonBody(objectSchema({ providerId: { type: "string" } }))
        })
      },
      "/api/catalog/{mediaType}/{id}/metadata/poster": {
        post: operation("Catalog", "Attach poster", "Caches a poster from an image URL or local file path.", true, {
          parameters: [pathParam("mediaType"), pathParam("id")],
          requestBody: jsonBody(objectSchema({ url: { type: "string" }, path: { type: "string" } }))
        })
      },
      "/api/catalog/{mediaType}/{id}/metadata/thumbnail": {
        get: operation("Catalog", "Episode thumbnail", "Serves a cached or generated thumbnail.", true, {
          parameters: [pathParam("mediaType"), pathParam("id")]
        })
      },
      "/api/catalog/metadata/poster/{filename}": {
        get: operation("Catalog", "Cached poster file", "Serves a cached poster image.", true, {
          parameters: [pathParam("filename")]
        })
      },
      "/api/catalog/metadata/posters/unavailable": {
        get: operation("Catalog", "Unavailable posters", "Lists records where poster lookup failed.", true, {
          parameters: [queryParam("limit", "integer")]
        })
      },
      "/api/catalog/metadata/recheck-missing": {
        get: operation("Catalog", "Missing metadata recheck status", "Returns background recheck state."),
        post: operation("Catalog", "Start missing metadata recheck", "Starts a background recheck.", true, {
          requestBody: jsonBody(objectSchema({ limit: { type: "integer" } }))
        })
      },
      "/api/catalog/{mediaType}/{id}/subtitles/search": {
        get: operation("Catalog", "Search subtitles", "Searches SubDL for possible subtitle matches.", true, {
          parameters: [pathParam("mediaType"), pathParam("id"), queryParam("language")]
        })
      },
      "/api/catalog/{mediaType}/{id}/subtitles/select": {
        post: operation("Catalog", "Download selected subtitle", "Downloads and optionally syncs one subtitle candidate.", true, {
          parameters: [pathParam("mediaType"), pathParam("id")],
          requestBody: jsonBody(objectSchema({ candidateId: { type: "string" } }))
        })
      },
      "/api/catalog/{mediaType}/{id}/pregenerate": {
        post: operation("Catalog", "Pre-generate HLS", "Starts HLS generation for a selected file.", true, {
          parameters: [pathParam("mediaType"), pathParam("id")]
        })
      },
      "/api/progress/on-deck": {
        get: operation("Playback Progress", "On Deck", "Returns in-progress items and next episodes.")
      },
      "/api/progress/history": {
        get: operation("Playback Progress", "Watch history", "Returns watched and in-progress items for the current user.")
      },
      "/api/progress/{mediaType}/{id}": {
        get: operation("Playback Progress", "Item progress", "Returns progress for one item.", true, {
          parameters: [pathParam("mediaType"), pathParam("id")]
        })
      },
      "/api/progress/{mediaType}/{id}/watched": {
        post: operation("Playback Progress", "Mark watched", "Marks one item watched.", true, {
          parameters: [pathParam("mediaType"), pathParam("id")]
        })
      },
      "/api/progress/{mediaType}/{id}/remove": {
        post: operation("Playback Progress", "Remove from On Deck", "Hides one item from On Deck.", true, {
          parameters: [pathParam("mediaType"), pathParam("id")]
        })
      },
      "/api/libraries": {
        get: operation("Libraries", "List managed libraries", "Includes active share URLs when permitted."),
        post: operation("Libraries", "Add library", "Adds a library and starts background indexing.", true, {
          requestBody: jsonBody({ $ref: "#/components/schemas/LibraryInput" })
        })
      },
      "/api/libraries/order": {
        put: operation("Libraries", "Reorder libraries", "Reorders libraries without rescanning.", true, {
          requestBody: jsonBody(objectSchema({ keys: { type: "array", items: { type: "string" } } }))
        })
      },
      "/api/libraries/{libraryKey}": {
        get: operation("Libraries", "Library details", "Lists shows or movies for a configured library.", true, {
          parameters: [pathParam("libraryKey")]
        }),
        delete: operation("Libraries", "Remove library", "Removes a library from Media Baker without deleting files.", true, {
          parameters: [pathParam("libraryKey")]
        })
      },
      "/api/libraries/{libraryKey}/reindex": {
        post: operation("Libraries", "Re-index one library", "Starts a background rebuild for one library.", true, {
          parameters: [pathParam("libraryKey")]
        })
      },
      "/api/libraries/{libraryKey}/shares": {
        post: operation("Libraries", "Create share URL", "Creates a revokable URL scoped to one library.", true, {
          parameters: [pathParam("libraryKey")]
        })
      },
      "/api/libraries/{libraryKey}/shares/{shareId}": {
        delete: operation("Libraries", "Revoke share URL", "Revokes a library share URL.", true, {
          parameters: [pathParam("libraryKey"), pathParam("shareId")]
        })
      },
      "/api/libraries/{libraryKey}/{itemId}": {
        get: operation("Libraries", "Show or movie details", "Returns one show or movie-like item.", true, {
          parameters: [pathParam("libraryKey"), pathParam("itemId")]
        })
      },
      "/api/libraries/{libraryKey}/{showId}/seasons/{seasonNumber}": {
        get: operation("Libraries", "Season details", "Returns one season from a TV-style library.", true, {
          parameters: [pathParam("libraryKey"), pathParam("showId"), pathParam("seasonNumber", "integer")]
        })
      },
      "/api/streams/{libraryKey}/{itemId}/master.m3u8": {
        get: operation("Streams", "Prepare and serve HLS playlist", "Requires a generated playback token. Query options include audio, subtitle, audioChannels, quality, 3d, and t.", true, {
          security: [{ PlaybackToken: [] }],
          parameters: [
            pathParam("libraryKey"),
            pathParam("itemId"),
            queryParam("audio"),
            queryParam("subtitle"),
            queryParam("audioChannels", "string", ["preserve", "stereo", "surround51", "stabby51"]),
            queryParam("quality", "string", ["original", "medium", "low"]),
            queryParam("3d", "string", ["1", "2", "3", "4"]),
            queryParam("t", "integer")
          ],
          responses: {
            200: {
              description: "HLS playlist",
              content: { "application/vnd.apple.mpegurl": { schema: { type: "string" } } }
            }
          }
        })
      },
      "/api/streams/hls/{cacheKey}/{filename}": {
        get: operation("Streams", "Serve HLS segment or playlist", "Requires an HLS-scoped playback token.", true, {
          security: [{ PlaybackToken: [] }],
          parameters: [pathParam("cacheKey"), pathParam("filename")]
        })
      }
    }
  };
}

function operation(tag, summary, description, secured = true, extra = {}) {
  return {
    tags: [tag],
    summary,
    description,
    ...(secured ? { security: extra.security || [{ SessionToken: [] }, { BearerAuth: [] }, { ApiKey: [] }, { ShareToken: [] }] } : { security: [] }),
    parameters: extra.parameters || [],
    requestBody: extra.requestBody,
    responses: extra.responses || {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: { type: "object", additionalProperties: true }
          }
        }
      },
      400: errorResponse(),
      401: errorResponse(),
      403: errorResponse(),
      404: errorResponse(),
      500: errorResponse()
    }
  };
}

function objectSchema(properties) {
  return {
    type: "object",
    properties
  };
}

function jsonBody(schema) {
  return {
    required: false,
    content: {
      "application/json": {
        schema
      }
    }
  };
}

function pathParam(name, type = "string") {
  return {
    name,
    in: "path",
    required: true,
    schema: { type }
  };
}

function queryParam(name, type = "string", values = null) {
  return {
    name,
    in: "query",
    required: false,
    schema: {
      type,
      ...(values ? { enum: values } : {})
    }
  };
}

function errorResponse() {
  return {
    description: "Error",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" }
      }
    }
  };
}

function swaggerHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Media Baker API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
    <style>
      html,
      body {
        margin: 0;
        background: #f6f8fb;
      }
      .swagger-ui {
        color: #1f2937;
      }
      .swagger-ui .topbar { display: none; }
      .swagger-ui .scheme-container {
        background: #ffffff;
        border-bottom: 1px solid #e5e7eb;
        box-shadow: none;
      }
      .swagger-ui .info {
        margin: 36px 0 28px;
      }
      .swagger-ui .info .title,
      .swagger-ui .info p,
      .swagger-ui .opblock-tag,
      .swagger-ui .opblock .opblock-summary-path,
      .swagger-ui .opblock .opblock-summary-description {
        color: #1f2937;
      }
      .swagger-ui .wrapper {
        max-width: 1480px;
      }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/api/docs/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        persistAuthorization: true
      });
    </script>
  </body>
</html>`;
}
