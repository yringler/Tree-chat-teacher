-- The pool's higher cap tier is the membership now, not "net purchases above $0"
-- (docs/DECISIONS.md, "Two tiers: free and member"). Past pool rows keep their
-- tier under the new name; the column has no constraint to change.
UPDATE `usage_events` SET `tier` = 'member' WHERE `tier` = 'supporter';
