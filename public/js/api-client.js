(function exposeApiClient(global) {
  async function requestJson(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      body: options.body
    });

    if (!response.ok) {
      throw new Error(await responseErrorMessage(response));
    }

    return response.json();
  }

  async function responseErrorMessage(response) {
    try {
      const data = await response.json();
      if (data && data.error) {
        return String(data.error);
      }
    } catch (err) {
      // The response status below is the useful fallback for non-JSON errors.
    }

    return response.statusText || `Request failed: ${response.status}`;
  }

  global.MediaBakerApi = Object.freeze({ requestJson });
})(window);
