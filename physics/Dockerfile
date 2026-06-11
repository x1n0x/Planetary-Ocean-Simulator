# Dedalus v3 isn't reliably pip-installable and has no native Windows build,
# so we precompute scenarios inside a Linux conda environment.
# The solver code is mounted at runtime (-v), not baked in, so edits don't
# require an image rebuild — this image is only the environment.
FROM mambaorg/micromamba:1.5-jammy

# conda-forge has dedalus for linux-64 with FFTW/MPI wired up.
RUN micromamba install -y -n base -c conda-forge \
        python=3.12 \
        "dedalus=3.0.5" \
        "zarr=2.18.*" \
        "numpy>=2.0" \
    && micromamba clean --all --yes

# Dedalus is single-threaded per process and warns otherwise (physics/README).
ENV OMP_NUM_THREADS=1 \
    NUMEXPR_MAX_THREADS=1 \
    OPENBLAS_NUM_THREADS=1

WORKDIR /work
