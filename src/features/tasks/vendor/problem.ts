// Stand-in for `@orbit/api/problem`. subIssuesLib only reads `.code`.
// Rewritten because Orbit's class parses a generated server problem Hivra does not have.
// Source: https://github.com/coollabsio/orbit (Apache-2.0).

export class ApiProblem extends Error {
  code: string;

  constructor(body: { code?: string; title?: string }) {
    super(body.title ?? "problem");
    this.name = "ApiProblem";
    this.code = body.code ?? "";
  }
}
