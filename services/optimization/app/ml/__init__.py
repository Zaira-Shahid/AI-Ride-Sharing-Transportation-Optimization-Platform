"""Phase 13 (AI/ML) - prototype only.

Every model here is trained on SYNTHETIC data (app/ml/synthetic_data.py's own generator), never on
real trips, because none exist yet at a scale worth training on (the spec's own line for this
phase: "Add ML only after reliable operational data exists"). Nothing in this package is wired
into any real matching, payment or notification decision - see app/ml/routes.py's own header
comment for the exact boundary. Every response these endpoints return carries `prototype: true`
and `trained_on: "synthetic_data"` so no consumer can mistake this for a production model.
"""
