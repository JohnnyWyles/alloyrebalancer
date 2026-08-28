# Security

This page builds and signs transactions that move real funds across several chains. It is alpha software
and has not been audited.

If you find a vulnerability, please do not open a public issue. Use GitHub's private vulnerability
reporting on this repository ("Security" tab, "Report a vulnerability"), which reaches the maintainer
directly. Include the route or stage involved, the API response or transaction that demonstrates the
problem, and whether funds were affected.

Scope that matters most: anything that lets a Skip, Chainflip or Nomic response reach a wallet prompt
without matching the pinned constants and your own addresses; anything that signs a stage twice; anything
that reads a balance baseline incorrectly. The test suite (`node test.mjs`) encodes the expected
behaviour for each of these; a failing test case is the most useful form of report.
