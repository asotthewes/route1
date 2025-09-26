-- Demo route: Deventer centrum, 6 stops
WITH r AS (
  INSERT INTO routes (title, city, is_published)
  VALUES ('demo-route', 'Deventer', true)
  RETURNING id
)
INSERT INTO stops (route_id, order_index, title, lat, lon, radius_m, qr_code, puzzle_markdown, answer_hash, hint_markdown, hint_penalty)
VALUES
((SELECT id FROM r), 1, 'De Waag',           52.255918, 6.160769, 40, 'stokvis://stop/waag', 'Hoe heet dit historische gebouw?', 'plain:de waag', 'Kijk naar de gevelsteen.', 10),
((SELECT id FROM r), 2, 'Lebuinuskerk',      52.255058, 6.160061, 40, 'stokvis://stop/lebuinus', 'Welke heilige hoort bij deze kerk?', 'plain:lebuinus', 'Zoek naar een plaquette.', 10),
((SELECT id FROM r), 3, 'Brink',             52.255749, 6.161822, 40, 'stokvis://stop/brink', 'Noem het plein waar je staat.', 'plain:de brink', 'Het plein is beroemd om de markt.', 10),
((SELECT id FROM r), 4, 'Bergkerk',          52.254028, 6.162908, 40, 'stokvis://stop/bergkerk', 'Wat is de hoogte in letters (kerk op de ___)?', 'plain:berg', 'Denk aan de straatnaam.', 10),
((SELECT id FROM r), 5, 'IJsselboulevard',   52.252646, 6.165752, 50, 'stokvis://stop/ijssel', 'Welke rivier zie je?', 'plain:ijssel', 'Grote rivier oost NL.', 10),
((SELECT id FROM r), 6, 'Bier & Spijs',      52.255600, 6.162700, 30, 'stokvis://stop/pils', 'Bestel een lokale speciaalbier: welk biermerk (naam) noem je?', 'plain:deventer koekbier', 'Vraag het aan de bar. ;)', 10);
