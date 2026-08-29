export interface Season {
  year: number
  start: string
  end: string
  current: boolean
  coverage?: {
    fixtures: {
      events: boolean
      lineups: boolean
      statistics_fixtures: boolean
      statistics_players: boolean
    }
    standings: boolean
    players: boolean
    top_scorers: boolean
    top_assists: boolean
    top_cards: boolean
    injuries: boolean
    predictions: boolean
    odds: boolean
  }
}

export interface SeasonInfo {
  league: {
    id: number
    name: string
    type: string
    logo: string
  }
  country: {
    name: string
    code: string
    flag: string
  }
  seasons: Season[]
}

export interface CurrentSeason {
  year: number
  start: string
  end: string
  current: boolean
}

export function getCurrentPremierLeagueSeason (now = new Date()): number {
  const year = now.getFullYear()
  // Nouvelle saison à partir du 1er août
  return now.getMonth() >= 7 ? year : year - 1
}

export interface SeasonConfig {
  PREMIER_LEAGUE_ID: 39
  MINIMUM_SEASON: 1992
  readonly MAXIMUM_SEASON: number
  DEFAULT_SEASON: 'current'
}

export const SEASON_CONFIG: SeasonConfig = {
  PREMIER_LEAGUE_ID: 39,
  MINIMUM_SEASON: 1992,
  get MAXIMUM_SEASON () {
    return getCurrentPremierLeagueSeason()
  },
  DEFAULT_SEASON: 'current'
}
