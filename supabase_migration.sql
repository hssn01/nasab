-- =============================================================================
-- Nasab Migration: JSON State → Relational (persons + unions)
-- Run AFTER supabase_relational_schema.sql has been applied.
-- Safe to run multiple times (uses ON CONFLICT DO NOTHING).
-- =============================================================================

-- Helper function: migrate ONE tree's JSON state into persons & unions tables
CREATE OR REPLACE FUNCTION migrate_tree_json_to_relational(p_tree_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_state       jsonb;
  v_tree_name   text;
  v_root        jsonb;
  v_persons_ct  int := 0;
  v_unions_ct   int := 0;
BEGIN
  -- 1. Fetch tree state
  SELECT state, name INTO v_state, v_tree_name
    FROM public.trees
   WHERE id = p_tree_id;

  IF v_state IS NULL THEN
    RETURN jsonb_build_object(
      'tree_id', p_tree_id,
      'status', 'skipped',
      'reason', 'no state column data'
    );
  END IF;

  v_root := v_state -> 'root';
  IF v_root IS NULL THEN
    RETURN jsonb_build_object(
      'tree_id', p_tree_id,
      'status', 'skipped',
      'reason', 'state.root is null'
    );
  END IF;

  -- 2. Update trees table metadata from JSON state
  UPDATE public.trees SET
    root_person_id    = COALESCE(v_root ->> 'id', root_person_id),
    phase             = COALESCE(v_state ->> 'phase', phase),
    current_person_id = v_state ->> 'currentPersonId',
    male_counter      = COALESCE((v_state ->> 'maleCounter')::int, male_counter),
    female_counter    = COALESCE((v_state ->> 'femaleCounter')::int, female_counter),
    males_queue       = COALESCE(v_state -> 'malesQueue', males_queue),
    current_male_index = COALESCE((v_state ->> 'currentMaleIndex')::int, current_male_index),
    linked_from       = v_state -> 'linkedFrom'
  WHERE id = p_tree_id;

  -- 3. Extract persons via recursive CTE
  WITH RECURSIVE tree_walk AS (
    -- Root node (no father)
    SELECT
      v_root ->> 'id'                            AS person_id,
      v_root ->> 'name'                          AS person_name,
      COALESCE(v_root ->> 'gender', 'M')         AS gender,
      NULL::text                                   AS father_id,
      v_root ->> 'mother'                         AS mother_id,
      0                                            AS birth_order,
      v_root -> 'branchMeta'                       AS branch_meta,
      v_root -> 'children'                         AS children_arr,
      v_root -> 'wives'                            AS wives_arr

    UNION ALL

    -- Children (recursive)
    SELECT
      child ->> 'id'                              AS person_id,
      child ->> 'name'                            AS person_name,
      COALESCE(child ->> 'gender', 'M')           AS gender,
      tw.person_id                                 AS father_id,
      child ->> 'mother'                           AS mother_id,
      idx                                          AS birth_order,
      child -> 'branchMeta'                        AS branch_meta,
      child -> 'children'                          AS children_arr,
      child -> 'wives'                             AS wives_arr
    FROM tree_walk tw,
         jsonb_array_elements(tw.children_arr) WITH ORDINALITY AS c(child, idx)
  )
  -- Insert persons
  INSERT INTO public.persons (id, tree_id, name, gender, father_id, mother_id, birth_order, branch_meta, updated_at)
  SELECT
    person_id,
    p_tree_id,
    person_name,
    LEFT(gender, 1),
    father_id,
    mother_id,
    birth_order,
    branch_meta,
    now()
  FROM tree_walk
  WHERE person_id IS NOT NULL
  ON CONFLICT (tree_id, id) DO NOTHING;

  GET DIAGNOSTICS v_persons_ct = ROW_COUNT;

  -- 4. Extract unions (wives) from each person node
  WITH RECURSIVE tree_walk AS (
    SELECT
      v_root ->> 'id'   AS person_id,
      v_root -> 'children' AS children_arr,
      v_root -> 'wives'    AS wives_arr
    UNION ALL
    SELECT
      child ->> 'id'       AS person_id,
      child -> 'children'  AS children_arr,
      child -> 'wives'     AS wives_arr
    FROM tree_walk tw,
         jsonb_array_elements(tw.children_arr) WITH ORDINALITY AS c(child, idx)
  ),
  extracted_unions AS (
    SELECT
      COALESCE(wife ->> 'id', 'u-' || tw.person_id || '-' || (w_idx - 1)::text) AS union_id,
      tw.person_id                                                                AS husband_id,
      COALESCE(wife ->> 'type', 'external')                                       AS wife_type,
      -- tree wife fields
      wife ->> 'personId'                                                          AS wife_person_id,
      (wife ->> 'treeId')                                                          AS wife_tree_id,
      wife ->> 'treeName'                                                          AS wife_tree_name,
      wife ->> 'personName'                                                        AS wife_person_name,
      wife ->> 'lineageLabel'                                                      AS wife_lineage_label,
      -- external wife fields
      wife ->> 'name'                                                              AS ext_name,
      wife ->> 'family'                                                            AS ext_family,
      wife ->> 'tribute'                                                           AS ext_tribute,
      (w_idx - 1)                                                                  AS marriage_order
    FROM tree_walk tw,
         jsonb_array_elements(tw.wives_arr) WITH ORDINALITY AS w(wife, w_idx)
    WHERE tw.wives_arr IS NOT NULL AND jsonb_array_length(tw.wives_arr) > 0
  )
  INSERT INTO public.unions (
    id, tree_id, husband_id, type,
    wife_person_id, wife_tree_id, wife_tree_name, wife_person_name, wife_lineage_label,
    external_name, external_family, external_tribute,
    marriage_order, updated_at
  )
  SELECT
    union_id,
    p_tree_id,
    husband_id,
    wife_type,
    wife_person_id,
    CASE WHEN wife_tree_id IS NOT NULL THEN wife_tree_id::uuid ELSE NULL END,
    wife_tree_name,
    wife_person_name,
    wife_lineage_label,
    ext_name,
    ext_family,
    ext_tribute,
    marriage_order::int,
    now()
  FROM extracted_unions
  WHERE union_id IS NOT NULL
  ON CONFLICT (tree_id, id) DO NOTHING;

  GET DIAGNOSTICS v_unions_ct = ROW_COUNT;

  RETURN jsonb_build_object(
    'tree_id', p_tree_id,
    'tree_name', v_tree_name,
    'status', 'migrated',
    'persons_inserted', v_persons_ct,
    'unions_inserted', v_unions_ct
  );
END;
$$;

-- =============================================================================
-- Batch migrate: run for ALL trees that have a JSON state column
-- =============================================================================

CREATE OR REPLACE FUNCTION migrate_all_trees_to_relational()
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_tree_id   UUID;
  v_result    jsonb;
  v_results   jsonb := '[]'::jsonb;
  v_total     int := 0;
  v_migrated  int := 0;
BEGIN
  FOR v_tree_id IN
    SELECT id FROM public.trees WHERE state IS NOT NULL
  LOOP
    v_total := v_total + 1;
    v_result := migrate_tree_json_to_relational(v_tree_id);
    v_results := v_results || jsonb_build_array(v_result);
    IF (v_result ->> 'status') = 'migrated' THEN
      v_migrated := v_migrated + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'total_trees', v_total,
    'migrated', v_migrated,
    'details', v_results
  );
END;
$$;

-- =============================================================================
-- Run the batch migration
-- =============================================================================

SELECT migrate_all_trees_to_relational();
