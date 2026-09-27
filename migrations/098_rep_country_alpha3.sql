-- 098_rep_country_alpha3.sql
--
-- 093 rewrote organisations.country_code from 2-letter codes ('WS') to
-- alpha-3 ('WSM'). It didn't touch competitor_dive_lists.rep_country, the
-- entry-time copy the 090 trigger takes of that same column, and
-- event_rep_code() / event_rep_ids() prefer that snapshot over the live
-- code. So divers entered between the 090 and 093 deploys from an org
-- that was stored as 'WS' kept printing WS on scoreboards, recaps and
-- PDFs, while everyone entered before 090 (no snapshot) or after 093
-- printed WSM. One event could hold both, and the medal table (grouped by
-- code) listed the country twice.
--
-- Same mapping as 093, generated from lib/countries.json, and
-- test/org-country-codes.test.js checks it hasn't drifted. The partner
-- column is here too for completeness: 095 fills it after 093 has run,
-- so it shouldn't hold a 2-letter code, but a hand-entered row costs
-- nothing to catch. Neither UPDATE touches partner_id, so the snapshot
-- trigger (INSERT OR UPDATE OF partner_id) stays out of it.
--
-- Idempotent: a second run finds nothing left to rewrite. Clear the
-- scoreboard/recap caches after deploying (restart does) so cached
-- archives pick up the new codes.

BEGIN;

CREATE TEMP TABLE _a2a3 (a2 text PRIMARY KEY, a3 text NOT NULL) ON COMMIT DROP;
INSERT INTO _a2a3 (a2, a3) VALUES
    ('AF','AFG'), ('AX','ALA'), ('AL','ALB'), ('DZ','DZA'), ('AS','ASM'), ('AD','AND'),
    ('AO','AGO'), ('AI','AIA'), ('AG','ATG'), ('AR','ARG'), ('AM','ARM'), ('AW','ABW'),
    ('AU','AUS'), ('AT','AUT'), ('AZ','AZE'), ('BS','BHS'), ('BH','BHR'), ('BD','BGD'),
    ('BB','BRB'), ('BY','BLR'), ('BE','BEL'), ('BZ','BLZ'), ('BJ','BEN'), ('BM','BMU'),
    ('BT','BTN'), ('BO','BOL'), ('BA','BIH'), ('BW','BWA'), ('BR','BRA'), ('VG','VGB'),
    ('BN','BRN'), ('BG','BGR'), ('BF','BFA'), ('BI','BDI'), ('KH','KHM'), ('CM','CMR'),
    ('CA','CAN'), ('CV','CPV'), ('BQ','BES'), ('KY','CYM'), ('CF','CAF'), ('TD','TCD'),
    ('CL','CHL'), ('CN','CHN'), ('CX','CXR'), ('CC','CCK'), ('CO','COL'), ('KM','COM'),
    ('CG','COG'), ('CD','COD'), ('CK','COK'), ('CR','CRI'), ('CI','CIV'), ('HR','HRV'),
    ('CU','CUB'), ('CW','CUW'), ('CY','CYP'), ('CZ','CZE'), ('DK','DNK'), ('DJ','DJI'),
    ('DM','DMA'), ('DO','DOM'), ('EC','ECU'), ('EG','EGY'), ('SV','SLV'), ('GQ','GNQ'),
    ('ER','ERI'), ('EE','EST'), ('SZ','SWZ'), ('ET','ETH'), ('FK','FLK'), ('FO','FRO'),
    ('FJ','FJI'), ('FI','FIN'), ('FR','FRA'), ('GF','GUF'), ('PF','PYF'), ('GA','GAB'),
    ('GM','GMB'), ('GE','GEO'), ('DE','DEU'), ('GH','GHA'), ('GI','GIB'), ('GR','GRC'),
    ('GL','GRL'), ('GD','GRD'), ('GP','GLP'), ('GU','GUM'), ('GT','GTM'), ('GG','GGY'),
    ('GN','GIN'), ('GW','GNB'), ('GY','GUY'), ('HT','HTI'), ('HN','HND'), ('HK','HKG'),
    ('HU','HUN'), ('IS','ISL'), ('IN','IND'), ('ID','IDN'), ('IR','IRN'), ('IQ','IRQ'),
    ('IE','IRL'), ('IM','IMN'), ('IL','ISR'), ('IT','ITA'), ('JM','JAM'), ('JP','JPN'),
    ('JE','JEY'), ('JO','JOR'), ('KZ','KAZ'), ('KE','KEN'), ('KI','KIR'), ('XK','XKX'),
    ('KW','KWT'), ('KG','KGZ'), ('LA','LAO'), ('LV','LVA'), ('LB','LBN'), ('LS','LSO'),
    ('LR','LBR'), ('LY','LBY'), ('LI','LIE'), ('LT','LTU'), ('LU','LUX'), ('MO','MAC'),
    ('MG','MDG'), ('MW','MWI'), ('MY','MYS'), ('MV','MDV'), ('ML','MLI'), ('MT','MLT'),
    ('MH','MHL'), ('MQ','MTQ'), ('MR','MRT'), ('MU','MUS'), ('YT','MYT'), ('MX','MEX'),
    ('FM','FSM'), ('MD','MDA'), ('MC','MCO'), ('MN','MNG'), ('ME','MNE'), ('MS','MSR'),
    ('MA','MAR'), ('MZ','MOZ'), ('MM','MMR'), ('NA','NAM'), ('NR','NRU'), ('NP','NPL'),
    ('NL','NLD'), ('NC','NCL'), ('NZ','NZL'), ('NI','NIC'), ('NE','NER'), ('NG','NGA'),
    ('NU','NIU'), ('NF','NFK'), ('KP','PRK'), ('MK','MKD'), ('MP','MNP'), ('NO','NOR'),
    ('OM','OMN'), ('PK','PAK'), ('PW','PLW'), ('PS','PSE'), ('PA','PAN'), ('PG','PNG'),
    ('PY','PRY'), ('PE','PER'), ('PH','PHL'), ('PN','PCN'), ('PL','POL'), ('PT','PRT'),
    ('PR','PRI'), ('QA','QAT'), ('RE','REU'), ('RO','ROU'), ('RU','RUS'), ('RW','RWA'),
    ('WS','WSM'), ('SM','SMR'), ('ST','STP'), ('SA','SAU'), ('SN','SEN'), ('RS','SRB'),
    ('SC','SYC'), ('SL','SLE'), ('SG','SGP'), ('SX','SXM'), ('SK','SVK'), ('SI','SVN'),
    ('SB','SLB'), ('SO','SOM'), ('ZA','ZAF'), ('KR','KOR'), ('SS','SSD'), ('ES','ESP'),
    ('LK','LKA'), ('BL','BLM'), ('SH','SHN'), ('KN','KNA'), ('LC','LCA'), ('MF','MAF'),
    ('PM','SPM'), ('VC','VCT'), ('SD','SDN'), ('SR','SUR'), ('SJ','SJM'), ('SE','SWE'),
    ('CH','CHE'), ('SY','SYR'), ('TW','TWN'), ('TJ','TJK'), ('TZ','TZA'), ('TH','THA'),
    ('TL','TLS'), ('TG','TGO'), ('TK','TKL'), ('TO','TON'), ('TT','TTO'), ('TN','TUN'),
    ('TR','TUR'), ('TM','TKM'), ('TC','TCA'), ('TV','TUV'), ('VI','VIR'), ('UG','UGA'),
    ('UA','UKR'), ('AE','ARE'), ('GB','GBR'), ('US','USA'), ('UY','URY'), ('UZ','UZB'),
    ('VU','VUT'), ('VA','VAT'), ('VE','VEN'), ('VN','VNM'), ('WF','WLF'), ('EH','ESH'),
    ('YE','YEM'), ('ZM','ZMB'), ('ZW','ZWE');

UPDATE public.competitor_dive_lists c
   SET rep_country = m.a3
  FROM _a2a3 m
 WHERE upper(btrim(c.rep_country)) IN (m.a2, m.a3)
   AND c.rep_country IS DISTINCT FROM m.a3;

UPDATE public.competitor_dive_lists c
   SET partner_rep_country = m.a3
  FROM _a2a3 m
 WHERE upper(btrim(c.partner_rep_country)) IN (m.a2, m.a3)
   AND c.partner_rep_country IS DISTINCT FROM m.a3;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 98, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
