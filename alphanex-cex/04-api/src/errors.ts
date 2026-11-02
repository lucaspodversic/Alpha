/**
 * EN: Typed HTTP errors. Services throw these; the Fastify error handler maps them to JSON.
 * ES: Errores HTTP tipados. Los servicios los lanzan; el manejador de errores de Fastify los mapea a JSON.
 */
export class ApiError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message?: string) {
    // EN: `code` is a stable machine-readable string the UI can switch on.
    // ES: `code` es un string estable y legible por máquina que la UI puede evaluar.
    super(message ?? code);
    this.name = 'ApiError';
  }
}

// EN: Shorthand constructors. / ES: Constructores abreviados.
export const badRequest = (code: string, msg?: string) => new ApiError(400, code, msg);
export const unauthorized = (msg = 'authentication required') => new ApiError(401, 'unauthorized', msg);
export const forbidden = (code = 'forbidden', msg?: string) => new ApiError(403, code, msg);
export const notFound = (code = 'not_found', msg?: string) => new ApiError(404, code, msg);
export const conflict = (code: string, msg?: string) => new ApiError(409, code, msg);
export const unavailable = (code: string, msg?: string) => new ApiError(503, code, msg);
