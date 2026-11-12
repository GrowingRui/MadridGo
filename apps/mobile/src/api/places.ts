// Address and place search (`GET /places/search`): streets, addresses and named places in the
// Comunidad de Madrid, from CartoCiudad (Instituto Geográfico Nacional) through our backend.
// Stops are not in it: they come from /stops/search, with their lines.

import type MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import type { Place } from '../state/planner';
import { getJson } from './client';

export type PlaceKind = 'address' | 'street' | 'place' | 'area';

export interface PlaceResult {
  id: string;
  name: string;
  /** Where it is: "28013 Madrid", "Parla". */
  detail: string | null;
  kind: PlaceKind;
  lat: number;
  lon: number;
  /** A business from the company register (the server lists these last). */
  business: boolean;
}

/** Fewer letters than this: no address search (the server refuses it too). */
export const PLACE_MIN_CHARS = 3;

export const searchPlaces = (q: string) => getJson<PlaceResult[]>('/places/search', { q });

/** The planner's place for a search result: a point with the place's name. */
export const placeFromResult = (r: PlaceResult): Place => ({
  id: `place:${r.id}`,
  name: r.name,
  lat: r.lat,
  lon: r.lon,
});

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

const ICONS: Record<PlaceKind, IconName> = {
  address: 'home-outline',
  street: 'road-variant',
  place: 'map-marker-outline',
  area: 'city-variant-outline',
};

export const placeIcon = (kind: PlaceKind): IconName => ICONS[kind] ?? 'map-marker-outline';
