// HTTP problem (RFC 9457) raised by the interface layer and rendered by the global filter.
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly extensions: Readonly<Record<string, unknown>> = {},
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(detail);
    this.name = 'HttpProblem';
  }
}

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Content',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function problemBody(problem: HttpProblem, correlationId: string): Record<string, unknown> {
  return {
    type: `urn:problem:${problem.code.toLowerCase().replaceAll('_', '-')}`,
    title: TITLES[problem.status] ?? 'Error',
    status: problem.status,
    code: problem.code,
    detail: problem.detail,
    correlationId,
    ...problem.extensions,
  };
}

export const invalidPayload = (detail: string) => new HttpProblem(400, 'INVALID_PAYLOAD', detail);

export const notFound = (detail = 'Resource not found') =>
  new HttpProblem(404, 'NOT_FOUND', detail);
