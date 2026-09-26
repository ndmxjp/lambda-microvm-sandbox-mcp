export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string): HttpError => new HttpError(400, "bad_request", message);
export const notFound = (message: string): HttpError => new HttpError(404, "not_found", message);
