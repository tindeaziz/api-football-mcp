import { EndpointToolSpec, P } from './endpoint-tool'

/**
 * Every API-Football v3 endpoint from the official architecture diagram
 * (https://www.api-football.com/documentation-v3#section/Architecture)
 * that is not already covered by a hand-written tool.
 *
 * Tools are generated from these specs by EndpointTool. Add a new endpoint
 * by adding an entry here — no other file needs to change.
 */
export const ENDPOINT_SPECS: EndpointToolSpec[] = [
  // ---------------------------------------------------------------- General
  {
    name: 'get_timezones',
    description: 'List all timezones supported by the API (use with fixtures)',
    endpoint: '/timezone',
    params: {},
    cache: 'HISTORICAL'
  },
  {
    name: 'get_countries',
    description: 'List countries available in the API, optionally filtered',
    endpoint: '/countries',
    params: {
      name: P.str('name', 'Country name'),
      code: P.str('code', 'Two-letter country code (e.g. GB, FR)'),
      search: P.str('search', 'Search term (min 3 chars)')
    },
    cache: 'HISTORICAL'
  },
  {
    name: 'get_seasons',
    description: 'List all seasons available in the API',
    endpoint: '/leagues/seasons',
    params: {},
    cache: 'HISTORICAL'
  },
  {
    name: 'get_leagues',
    description: 'List leagues and cups with per-season coverage; use it to discover league IDs and which seasons your plan can access',
    endpoint: '/leagues',
    params: {
      leagueId: P.num('id', 'League ID'),
      name: P.str('name', 'League name'),
      country: P.str('country', 'Country name'),
      code: P.str('code', 'Country code'),
      season: P.season(),
      teamId: P.num('team', 'Team ID'),
      type: P.str('type', 'league or cup', false, ['league', 'cup']),
      current: P.bool('current', 'Only leagues with an active season'),
      search: P.str('search', 'Search term (min 3 chars)'),
      last: P.num('last', 'Last N leagues added')
    },
    cache: 'HISTORICAL'
  },

  // ---------------------------------------------------------------- Fixtures
  {
    name: 'get_fixtures_by_ids',
    description: 'Get up to 20 fixtures in one call with events, lineups, statistics and player stats included',
    endpoint: '/fixtures',
    params: {
      ids: P.str('ids', 'Fixture IDs joined by "-" (max 20, e.g. "1208021-1208022")', true),
      timezone: P.str('timezone', 'Timezone name (see get_timezones)')
    },
    cache: 'CURRENT'
  },
  {
    name: 'get_fixture_rounds',
    description: 'List the rounds of a league season (e.g. "Regular Season - 12")',
    endpoint: '/fixtures/rounds',
    params: {
      leagueId: P.league(),
      season: P.season(true),
      current: P.bool('current', 'Only the current round'),
      dates: P.bool('dates', 'Include the dates of each round')
    },
    cache: 'CURRENT'
  },
  {
    name: 'get_head_to_head',
    description: 'Head-to-head fixtures between two teams',
    endpoint: '/fixtures/headtohead',
    params: {
      h2h: P.str('h2h', 'Two team IDs joined by "-" (e.g. "40-42")', true),
      leagueId: P.num('league', 'Restrict to a league ID'),
      season: P.season(),
      last: P.num('last', 'Last N fixtures'),
      next: P.num('next', 'Next N fixtures'),
      from: P.str('from', 'Start date YYYY-MM-DD'),
      to: P.str('to', 'End date YYYY-MM-DD'),
      status: P.str('status', 'Fixture status (NS, FT, ...)'),
      timezone: P.str('timezone', 'Timezone name')
    },
    cache: 'CURRENT'
  },
  {
    name: 'get_fixture_statistics',
    description: 'Team statistics for a fixture (shots, possession, passes, xG, ...)',
    endpoint: '/fixtures/statistics',
    params: {
      fixtureId: P.num('fixture', 'Fixture ID', true),
      teamId: P.num('team', 'Restrict to one team'),
      type: P.str('type', 'Restrict to one statistic type'),
      half: P.bool('half', 'Include first/second half breakdown')
    },
    cache: 'CURRENT'
  },
  {
    name: 'get_fixture_lineups',
    description: 'Lineups, formations, substitutes and coaches for a fixture',
    endpoint: '/fixtures/lineups',
    params: {
      fixtureId: P.num('fixture', 'Fixture ID', true),
      teamId: P.num('team', 'Restrict to one team'),
      playerId: P.num('player', 'Restrict to one player'),
      type: P.str('type', 'startXI or substitutes')
    },
    cache: 'CURRENT'
  },
  {
    name: 'get_fixture_player_stats',
    description: 'Per-player statistics for a fixture (rating, minutes, shots, passes, duels, ...)',
    endpoint: '/fixtures/players',
    params: {
      fixtureId: P.num('fixture', 'Fixture ID', true),
      teamId: P.num('team', 'Restrict to one team')
    },
    cache: 'CURRENT'
  },

  // ---------------------------------------------------------------- Teams
  {
    name: 'get_team_statistics',
    description: 'Aggregated season statistics for a team in a league (form, goals per minute, clean sheets, formations, ...)',
    endpoint: '/teams/statistics',
    params: {
      leagueId: P.league(),
      season: P.season(true),
      teamId: P.num('team', 'Team ID', true),
      date: P.str('date', 'Compute statistics up to this date YYYY-MM-DD')
    },
    cache: 'CURRENT'
  },
  {
    name: 'get_team_seasons',
    description: 'Seasons available for a team',
    endpoint: '/teams/seasons',
    params: { teamId: P.num('team', 'Team ID', true) },
    cache: 'HISTORICAL'
  },
  {
    name: 'get_team_countries',
    description: 'Countries available for the teams endpoint',
    endpoint: '/teams/countries',
    params: {},
    cache: 'HISTORICAL'
  },
  {
    name: 'get_venues',
    description: 'Stadium / venue information',
    endpoint: '/venues',
    params: {
      venueId: P.num('id', 'Venue ID'),
      name: P.str('name', 'Venue name'),
      city: P.str('city', 'City'),
      country: P.str('country', 'Country'),
      search: P.str('search', 'Search term (min 3 chars)')
    },
    cache: 'HISTORICAL',
    requireOneOf: [['venueId'], ['name'], ['city'], ['country'], ['search']]
  },

  // ---------------------------------------------------------------- Players
  {
    name: 'get_player_seasons',
    description: 'Seasons available for the players endpoint (optionally for a player)',
    endpoint: '/players/seasons',
    params: { playerId: P.num('player', 'Player ID') },
    cache: 'HISTORICAL'
  },
  {
    name: 'get_player_profiles',
    description: 'Player profile without statistics (by ID or last-name search)',
    endpoint: '/players/profiles',
    params: {
      playerId: P.num('player', 'Player ID'),
      search: P.str('search', 'Last name (min 3 chars)'),
      page: P.num('page', 'Page number')
    },
    cache: 'PROFILES',
    requireOneOf: [['playerId'], ['search']]
  },
  {
    name: 'get_player_teams',
    description: 'Every team and season a player has played for',
    endpoint: '/players/teams',
    params: { playerId: P.num('player', 'Player ID', true) },
    cache: 'PROFILES'
  },
  {
    name: 'get_official_squad',
    description: 'Current official squad of a team (numbers, positions) or every team of a player',
    endpoint: '/players/squads',
    params: {
      teamId: P.num('team', 'Team ID'),
      playerId: P.num('player', 'Player ID')
    },
    cache: 'PROFILES',
    requireOneOf: [['teamId'], ['playerId']]
  },
  {
    name: 'get_top_scorers',
    description: 'Top 20 scorers of a league season',
    endpoint: '/players/topscorers',
    params: { leagueId: P.league(), season: P.season(true) },
    cache: 'CURRENT'
  },
  {
    name: 'get_top_assists',
    description: 'Top 20 assist providers of a league season',
    endpoint: '/players/topassists',
    params: { leagueId: P.league(), season: P.season(true) },
    cache: 'CURRENT'
  },
  {
    name: 'get_top_yellow_cards',
    description: 'Top 20 players by yellow cards in a league season',
    endpoint: '/players/topyellowcards',
    params: { leagueId: P.league(), season: P.season(true) },
    cache: 'CURRENT'
  },
  {
    name: 'get_top_red_cards',
    description: 'Top 20 players by red cards in a league season',
    endpoint: '/players/topredcards',
    params: { leagueId: P.league(), season: P.season(true) },
    cache: 'CURRENT'
  },
  {
    name: 'get_league_players',
    description: 'All players of a league season with statistics (aggregates every page — 1 API call per page of 20)',
    endpoint: '/players',
    params: { leagueId: P.league(), season: P.season(true), teamId: P.num('team', 'Restrict to one team') },
    cache: 'CURRENT',
    paginate: true
  },

  // ---------------------------------------------------------------- Injuries / predictions
  {
    name: 'get_injuries',
    description: 'Injuries and suspensions for a league, team, player, fixture or date',
    endpoint: '/injuries',
    params: {
      leagueId: P.num('league', 'League ID'),
      season: P.season(),
      teamId: P.num('team', 'Team ID'),
      playerId: P.num('player', 'Player ID'),
      fixtureId: P.num('fixture', 'Fixture ID'),
      ids: P.str('ids', 'Fixture IDs joined by "-" (max 20)'),
      date: P.str('date', 'Date YYYY-MM-DD'),
      timezone: P.str('timezone', 'Timezone name')
    },
    cache: 'CURRENT',
    requireOneOf: [['leagueId', 'season'], ['teamId', 'season'], ['playerId', 'season'], ['fixtureId'], ['ids'], ['date']]
  },
  {
    name: 'get_predictions',
    description: 'API-Football pre-match prediction for a fixture (winner, advice, percentages, comparison, H2H)',
    endpoint: '/predictions',
    params: { fixtureId: P.num('fixture', 'Fixture ID', true) },
    cache: 'CURRENT'
  },

  // ---------------------------------------------------------------- Coachs / transfers / trophies / sidelined
  {
    name: 'get_coaches',
    description: 'Coach profile and career (by ID, team or name search)',
    endpoint: '/coachs',
    params: {
      coachId: P.num('id', 'Coach ID'),
      teamId: P.num('team', 'Team ID'),
      search: P.str('search', 'Coach name (min 3 chars)')
    },
    cache: 'PROFILES',
    requireOneOf: [['coachId'], ['teamId'], ['search']]
  },
  {
    name: 'get_transfers',
    description: 'Transfer history of a player or a team',
    endpoint: '/transfers',
    params: {
      playerId: P.num('player', 'Player ID'),
      teamId: P.num('team', 'Team ID')
    },
    cache: 'PROFILES',
    requireOneOf: [['playerId'], ['teamId']]
  },
  {
    name: 'get_trophies',
    description: 'Trophies won by a player or a coach',
    endpoint: '/trophies',
    params: {
      playerId: P.num('player', 'Player ID'),
      coachId: P.num('coach', 'Coach ID')
    },
    cache: 'HISTORICAL',
    requireOneOf: [['playerId'], ['coachId']]
  },
  {
    name: 'get_sidelined',
    description: 'Sidelined periods (injury, suspension) of a player or a coach',
    endpoint: '/sidelined',
    params: {
      playerId: P.num('player', 'Player ID'),
      coachId: P.num('coach', 'Coach ID')
    },
    cache: 'PROFILES',
    requireOneOf: [['playerId'], ['coachId']]
  },

  // ---------------------------------------------------------------- Odds
  {
    name: 'get_odds',
    description: 'Pre-match odds by fixture, league/season, date, bookmaker or bet type',
    endpoint: '/odds',
    params: {
      fixtureId: P.num('fixture', 'Fixture ID'),
      leagueId: P.num('league', 'League ID'),
      season: P.season(),
      date: P.str('date', 'Date YYYY-MM-DD'),
      bookmakerId: P.num('bookmaker', 'Bookmaker ID (see get_odds_bookmakers)'),
      betId: P.num('bet', 'Bet type ID (see get_odds_bets)'),
      timezone: P.str('timezone', 'Timezone name'),
      page: P.num('page', 'Page number')
    },
    cache: 'CURRENT',
    requireOneOf: [['fixtureId'], ['leagueId', 'season'], ['date'], ['bookmakerId'], ['betId']]
  },
  {
    name: 'get_odds_mapping',
    description: 'Fixtures that have odds available, with their update dates',
    endpoint: '/odds/mapping',
    params: { page: P.num('page', 'Page number') },
    cache: 'CURRENT'
  },
  {
    name: 'get_odds_bookmakers',
    description: 'List of bookmakers (IDs to use with get_odds)',
    endpoint: '/odds/bookmakers',
    params: { bookmakerId: P.num('id', 'Bookmaker ID'), search: P.str('search', 'Search term') },
    cache: 'HISTORICAL'
  },
  {
    name: 'get_odds_bets',
    description: 'List of pre-match bet types (IDs to use with get_odds)',
    endpoint: '/odds/bets',
    params: { betId: P.num('id', 'Bet ID'), search: P.str('search', 'Search term') },
    cache: 'HISTORICAL'
  },
  {
    name: 'get_live_odds',
    description: 'In-play odds for fixtures currently live',
    endpoint: '/odds/live',
    params: {
      fixtureId: P.num('fixture', 'Fixture ID'),
      leagueId: P.num('league', 'League ID'),
      betId: P.num('bet', 'Live bet type ID (see get_live_odds_bets)')
    },
    cache: 'LIVE'
  },
  {
    name: 'get_live_odds_bets',
    description: 'List of in-play bet types (IDs to use with get_live_odds)',
    endpoint: '/odds/live/bets',
    params: { betId: P.num('id', 'Bet ID'), search: P.str('search', 'Search term') },
    cache: 'HISTORICAL'
  }
]
