# Media Baker Custom Metadata API

This document defines version 1 of the source-neutral HTTP API that a custom metadata service must implement for Media Baker. The service may obtain metadata from any source it is permitted to use; source names, credentials, payloads, and identifiers are private implementation details and must not be exposed through this API.

## Conventions

- Routes are relative to the configured service base URL.
- Requests and JSON responses use UTF-8.
- IDs are opaque, stable, URL-safe strings assigned by the metadata service.
- Media Baker must not infer meaning from an ID.
- Unknown response properties may be ignored.
- Dates use ISO 8601 where available.
- `mediaType` is `movie`, `series`, or `music` for searchable records.

## Authentication

`GET /health` is public. Every `/api/v1` endpoint requires either:

```http
Authorization: Bearer YOUR_API_KEY
```

or:

```http
X-API-Key: YOUR_API_KEY
```

Missing or invalid credentials return `401` with `{"error":"Unauthorized"}`.

## Language And Cache Identity

Media Baker supplies language preferences per request. The service must forward them to its backend where supported and keep differently localized responses in separate cache entries.

- `language` is the requested metadata locale, such as `en-US`.
- `artworkLanguages` is a comma-separated preference list, such as `en,null,ja`; `null` means artwork without a language.
- Search identity includes `mediaType`, title, year, artist, language, artwork languages, and search type where supplied.
- Detail identity includes the opaque item ID, media type, language, artwork languages, and season or episode coordinates where applicable.

When a cached detail record is missing expected fields, the service should retry its backend on the next request for that exact identity. Newly available fields are merged into the cached record before responding. If refresh fails and an older record exists, it may be returned with `refreshError`.

## Health

### `GET /health`

```json
{
  "ok": true
}
```

## Search

### `POST /api/v1/search`

Searches for normalized metadata candidates.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `mediaType` | string | Yes | `movie`, `series`, or `music` |
| `title` | string | Yes | Movie, series, album, or track title |
| `year` | integer or null | No | Release or first-air year |
| `artist` | string or null | Music only | Artist name |
| `language` | string or null | No | Requested metadata locale |
| `artworkLanguages` | array or string | No | Ordered artwork-language preferences |
| `searchType` | string | Music only | `album` or `track`; defaults to `album` |

```json
{
  "mediaType": "movie",
  "title": "Example Film",
  "year": 1979,
  "language": "en-US",
  "artworkLanguages": ["en", "null"]
}
```

```json
{
  "cached": false,
  "items": [
    {
      "id": "96e81b8543f4f9c999ddaa5f24bb40e172abf02f72a444833767a48180b712df",
      "mediaType": "movie",
      "title": "Example Film",
      "originalTitle": "Example Film",
      "releaseDate": "1979-05-25",
      "releaseYear": 1979,
      "overview": "A short plot summary.",
      "originalLanguage": "en",
      "popularity": 100.5,
      "voteCount": 15000,
      "artwork": {
        "id": "ea3db2d17e8f887e1ba62c254dca275f4998b95222863110b612a6d33f3ec3a9",
        "url": "/api/v1/assets/ea3db2d17e8f887e1ba62c254dca275f4998b95222863110b612a6d33f3ec3a9"
      }
    }
  ]
}
```

`cached` is informational. Media Baker consumes `items` regardless of its value.

## Item Details

### `GET /api/v1/media/{mediaType}/{id}`

`mediaType` is `movie`, `series`, or `music`. `id` is an opaque ID previously returned by search.

```http
GET /api/v1/media/movie/96e81b8543f4f9c999ddaa5f24bb40e172abf02f72a444833767a48180b712df?language=en-US&artworkLanguages=en%2Cnull
```

```json
{
  "cached": true,
  "item": {
    "id": "96e81b8543f4f9c999ddaa5f24bb40e172abf02f72a444833767a48180b712df",
    "mediaType": "movie",
    "title": "Example Film",
    "originalTitle": "Example Film",
    "releaseDate": "1979-05-25",
    "releaseYear": 1979,
    "overview": "A short plot summary.",
    "originalLanguage": "en",
    "artist": null,
    "popularity": 100.5,
    "voteCount": 15000,
    "artwork": null
  }
}
```

An incomplete response includes `missingFields`. If an incomplete cached record cannot be refreshed, the response may also include `refreshError`.

## Seasons

### `GET /api/v1/series/{id}/seasons/{season}`

```http
GET /api/v1/series/96e81b8543f4f9c999ddaa5f24bb40e172abf02f72a444833767a48180b712df/seasons/1?language=en-US&artworkLanguages=en%2Cnull
```

```json
{
  "cached": false,
  "item": {
    "id": "96e81b8543f4f9c999ddaa5f24bb40e172abf02f72a444833767a48180b712df",
    "mediaType": "season",
    "title": "Season 1",
    "releaseDate": "2011-04-17",
    "releaseYear": 2011,
    "overview": "Season summary.",
    "seasonNumber": 1,
    "artwork": null,
    "episodes": []
  }
}
```

The optional `episodes` array contains normalized episode records using the fields below.

## Episodes

### `GET /api/v1/series/{id}/seasons/{season}/episodes/{episode}`

```http
GET /api/v1/series/96e81b8543f4f9c999ddaa5f24bb40e172abf02f72a444833767a48180b712df/seasons/1/episodes/1?language=en-US&artworkLanguages=en%2Cnull
```

```json
{
  "cached": false,
  "item": {
    "id": "573e681f334f948155de36cca29e0193e6556557baed0ca2b5b905832346dda1",
    "mediaType": "episode",
    "title": "Episode 1",
    "releaseDate": "2011-04-17",
    "releaseYear": 2011,
    "overview": "Episode summary.",
    "seasonNumber": 1,
    "episodeNumber": 1,
    "artwork": null
  }
}
```

## Normalized Fields

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Required opaque, stable ID |
| `mediaType` | string | Required normalized media type |
| `title` | string or null | Display title |
| `originalTitle` | string or null | Original-language title where available |
| `releaseDate` | string or null | ISO date where available |
| `releaseYear` | integer or null | Release or first-air year |
| `overview` | string or null | Plot, season, episode, or album summary |
| `originalLanguage` | string or null | Original language code where available |
| `artist` | string or null | Music artist |
| `seasonNumber` | integer or null | Season and episode records |
| `episodeNumber` | integer or null | Episode records |
| `popularity` | number | Optional ranking signal |
| `voteCount` | integer | Optional ranking signal |
| `artwork` | object or null | Stable asset ID and relative asset URL |
| `episodes` | array | Optional on season records |

Upstream payloads and identifiers are deliberately absent from the contract.

## Artwork

### `GET /api/v1/assets/{assetId}`

Artwork may be fetched lazily. A compatible service must:

- require API authentication;
- return `Content-Type: image/webp`;
- preserve aspect ratio;
- fit the image within 1024x1024 without unnecessary enlargement;
- return stable content for a stable asset ID;
- return `404` if the asset is unknown or unavailable.

Recommended cache header:

```http
Cache-Control: private, max-age=31536000, immutable
```

## Errors

All JSON errors use `{"error":"Human-readable message"}`.

| Status | Meaning |
| --- | --- |
| `400` | Invalid media type, parameters, or request body |
| `401` | Missing or invalid API key |
| `404` | Item or artwork not found |
| `429` | Backend rate limit reached and no cache is available |
| `500` | Unexpected service failure |
| `502` | Backend returned an unusable response |
| `503` | Backend or credentials unavailable |

## Compatibility Checklist

1. Authenticate every `/api/v1` request.
2. Search movies, series, and music using normalized media types.
3. Return stable opaque IDs without exposing backend identities.
4. Retrieve movie, series, music, season, and episode details.
5. Isolate cache entries by locale and artwork-language preferences.
6. Refresh incomplete detail records when requested again.
7. Serve authenticated WebP artwork no larger than 1024x1024.
8. Keep backend-specific payloads and terminology outside the API.
