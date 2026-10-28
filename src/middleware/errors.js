function notFoundHandler(req, res, _next) {
  res.status(404).json({
    error: {
      code: "ROUTE_NOT_FOUND",
      message: `Route ${req.method} ${req.originalUrl} was not found.`
    }
  });
}

function errorHandler(error, _req, res, _next) {
  if (error && error.name === "ZodError") {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
        details: error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message
        }))
      }
    });
  }

  if (error && error.code === "23505") {
    return res.status(409).json({
      error: {
        code: "DUPLICATE_RESOURCE",
        message: "A resource with the same unique identifier already exists."
      }
    });
  }

  if (error && error.code === "23503") {
    return res.status(404).json({
      error: { code: "RELATED_RESOURCE_NOT_FOUND", message: "A referenced resource was not found." }
    });
  }

  console.error(error);
  const status = Number.isInteger(error.status) ? error.status : 500;
  const code = error.codeName || (status === 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_ERROR");
  const message = status === 500 ? "An unexpected server error occurred." : error.message;

  return res.status(status).json({ error: { code, message } });
}

function createHttpError(status, codeName, message) {
  const error = new Error(message);
  error.status = status;
  error.codeName = codeName;
  return error;
}

module.exports = { notFoundHandler, errorHandler, createHttpError };
