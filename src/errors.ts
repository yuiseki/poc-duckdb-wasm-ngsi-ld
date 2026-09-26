export type ProblemType = 'BadRequestData' | 'InvalidRequest' | 'AlreadyExists' | 'ResourceNotFound' | 'OperationNotSupported' | 'InternalError';

/** An NGSI-LD error, rendered as a ProblemDetails response by the broker. */
export class NgsiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemType,
    readonly detail: string,
  ) {
    super(`${problem}: ${detail}`);
  }

  toResponse(): Response {
    return Response.json(
      { type: `https://uri.etsi.org/ngsi-ld/errors/${this.problem}`, title: this.problem, detail: this.detail },
      { status: this.status },
    );
  }
}

export const badRequest = (detail: string) => new NgsiError(400, 'BadRequestData', detail);
