-- 093_org_country_codes.sql
--
-- organisations.country_code is meant to be ISO 3166-1 alpha-3 ('AUS'),
-- and club-first signup (087) looks federations up by exactly that. But
-- register-org used to take a 2-letter code as well ('WS' for Samoa), so
-- a federation registered that way was invisible to its own country's
-- signups, and the first club from Samoa started a second, unclaimed
-- Samoa account right next to it.
--
-- This rewrites 2-letter codes (and any lower-case 3-letter ones) to the
-- alpha-3 code. The mapping below is generated from lib/countries.json,
-- the same list the server and the signup picker use, and
-- test/org-country-codes.test.js fails if the two ever drift:
--
--   node -e "require('./lib/countries.json').forEach(c => console.log(c.a2, c.a3))"
--
-- NULL codes stay NULL, there's nothing to go on. The sysadmin fixes those
-- from User Manager (Pending tab), which lists every live org signups
-- can't find by country, along with codes that aren't in the list at all
-- (IOC codes like GER, typos). Until this has run, routes/auth.js also
-- matches the alpha-2 code when it looks a country up.
--
-- Idempotent: a second run finds nothing left to rewrite.

BEGIN;

UPDATE public.organisations o
   SET country_code = m.a3
  FROM (VALUES
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
    ('YE','YEM'), ('ZM','ZMB'), ('ZW','ZWE')
  ) AS m(a2, a3)
 WHERE upper(btrim(o.country_code)) IN (m.a2, m.a3)
   AND o.country_code IS DISTINCT FROM m.a3
   -- The one-unclaimed-account-per-country index would refuse this, and
   -- rightly: that country already has its clubs' account.
   AND NOT (
     o.claim_state = 'unclaimed' AND EXISTS (
       SELECT 1 FROM public.organisations x
        WHERE x.claim_state = 'unclaimed' AND x.country_code = m.a3 AND x.id <> o.id
     )
   );

-- Say how many are left for a human, so the deploy log isn't silent
-- about orgs nobody can join yet.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM public.organisations
   WHERE id <> '00000000-0000-0000-0000-000000000001'
     AND (country_code IS NULL OR btrim(country_code) !~ '^[A-Z]{3}$');
  IF n > 0 THEN
    RAISE NOTICE '093: % organisation(s) still have no usable country_code; set them from User Manager as sysadmin', n;
  END IF;
END $$;

-- ---- bump schema version --------------------------------------
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 93, now())
ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;

COMMIT;
