/** Operational event adapter. No network, storage, company identifiers or search/contact content. */
export type StarMapEvent =
  | 'star_map_open'
  | 'search_result_selected'
  | 'enterprise_detail_open'
  | 'peer_view_open'
  | 'public_contact_copy'
  | 'website_open'
  | 'relation_mode_changed'
  | 'star_map_error';
export function emitStarMapEvent(
  event: StarMapEvent,
  source: 'real' | 'demo',
  relationType: 'same_industry' | 'supply_demand' = 'same_industry',
): void {
  window.dispatchEvent(
    new CustomEvent('otto:star-map-usage', {
      detail: {
        event,
        dataSource: source,
        relationType,
        entry: 'park_services',
        schemaVersion: 1,
      },
    }),
  );
}
