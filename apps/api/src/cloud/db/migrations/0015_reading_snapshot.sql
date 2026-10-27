-- Only the disposable change journal may be compacted; immutable events and memberships remain authority.
ALTER TABLE workspace_change_heads ADD COLUMN retained_from bigint NOT NULL DEFAULT 0
  CHECK (retained_from >= 0 AND retained_from <= change_seq);

CREATE FUNCTION protect_reading_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.retained_from < OLD.retained_from OR NEW.change_seq < OLD.change_seq THEN
    RAISE EXCEPTION 'reading journal watermarks cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reading_retention_monotonic BEFORE UPDATE ON workspace_change_heads
  FOR EACH ROW EXECUTE FUNCTION protect_reading_retention();
