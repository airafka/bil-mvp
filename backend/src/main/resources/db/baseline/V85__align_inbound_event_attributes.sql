-- Keep site verbatim, including deliveries with an unknown site. The journal stores the resolved area code separately.
ALTER TABLE inbound_event ADD COLUMN terminal_area text;
UPDATE inbound_event e SET terminal_area=a.code FROM terminal_area_catalog a WHERE lower(a.name)=lower(e.site);
ALTER TABLE inbound_event RENAME COLUMN action_code TO action_codes;
ALTER TABLE inbound_event ALTER COLUMN action_codes TYPE text[]
    USING array_remove(ARRAY[action_codes], NULL);
ALTER TABLE inbound_event ALTER COLUMN action_codes SET NOT NULL;
ALTER TABLE inbound_event ALTER COLUMN action_codes SET DEFAULT ARRAY[]::text[];
