"""Real-time data: source adapters, freshness, resilience and the stop-board overlay.

See docs/RELIABILITY_STRATEGY.md. Every live value carries its source, the time the source
produced it (when known) and the time MadridGo retrieved it.
"""
