// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Source: https://github.com/coollabsio/orbit
// Original path: packages/api/src/problem.ts
// The upstream file has no file-level copyright line. See ./LICENSE.
// Stand-in for `@orbit/api/problem`. subIssuesLib only reads `.code`.
// Rewritten because Orbit's class parses a generated server problem Hivra does not have.

export class ApiProblem extends Error {
  code: string;

  constructor(body: { code?: string; title?: string }) {
    super(body.title ?? "problem");
    this.name = "ApiProblem";
    this.code = body.code ?? "";
  }
}
