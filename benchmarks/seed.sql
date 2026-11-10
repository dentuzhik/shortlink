INSERT INTO links (code, target_url)
SELECT code, 'https://example.com/benchmark/' || code
FROM (
  SELECT lpad(id::text, 8, '0') AS code
  FROM generate_series(1, 1000) AS ids(id)
) AS fixtures;

ANALYZE links;
