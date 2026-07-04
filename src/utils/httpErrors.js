function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isClientAbort(err) {
  if (!err) {
    return false;
  }
  return ["ECONNABORTED", "ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"].includes(err.code)
    || /request aborted|premature close/i.test(String(err.message || ""));
}

module.exports = { httpError, isClientAbort };
