-- The edge functions use the service role, and on this project a new table doesn't give the service
-- role any read or write access by default (only TRUNCATE, REFERENCES and TRIGGER). Without these
-- grants checkRateLimit() errors and refuses every publish and rating.

grant select, insert, delete on public.rate_limit_events to service_role;
