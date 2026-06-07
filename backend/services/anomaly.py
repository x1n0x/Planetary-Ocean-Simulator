"""Anomaly detection — three independent layers (CLAUDE.md §6).

Stub for Phase 0. Implemented in Phase 3 (threshold + energy spike) and
Phase 4 (isolation forest). Always apply the wet mask (chi < 0.5) before
flagging so land cells are never reported as anomalies.
"""
