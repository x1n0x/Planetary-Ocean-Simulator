// Shared data-contract types — mirror the backend JSON (CLAUDE.md §4, §5.3).

export interface OceanState {
  scenario: string
  t: number
  eta: number[][] // (lat, lon) surface elevation, metres
  u: number[][] // (lat, lon) zonal velocity, m/s
  v: number[][] // (lat, lon) meridional velocity, m/s
  E_k: number
  E_p: number
}

export interface Scenario {
  id: string
  moon_dist_km: number
  moon_mass_rel: number
  omega_rad_s: number
  temperature_C: number
  grid_shape: [number, number]
  dt_seconds: number
  T_total_steps: number
  lat_range: [number, number]
  lon_range: [number, number]
}

export interface LandMask {
  chi: number[][] // (lat, lon) 0 = ocean, 1 = land
}
