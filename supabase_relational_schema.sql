-- =============================================================================
-- Nasab (نَسَب) — Relational Genealogy Graph Schema
-- Transforms monolithic JSON tree documents into normalized relational tables
-- =============================================================================

-- Enable UUID extension if not enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Trees Table (المشجرات والشجرات العائلية)
CREATE TABLE IF NOT EXISTS public.trees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    root_person_id TEXT,
    phase TEXT DEFAULT 'setup' CHECK (phase IN ('setup', 'enter-children', 'add-wives', 'assign-mothers', 'complete')),
    current_person_id TEXT,
    male_counter INT DEFAULT 1,
    female_counter INT DEFAULT 0,
    males_queue JSONB DEFAULT '[]'::jsonb,
    current_male_index INT DEFAULT 0,
    linked_from JSONB,
    state JSONB, -- Retained for dual-write compatibility during transition
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Persons Table (الأفراد - بنين وبنات)
CREATE TABLE IF NOT EXISTS public.persons (
    id TEXT NOT NULL, -- e.g. M001, F001 (scoped to tree_id)
    tree_id UUID NOT NULL REFERENCES public.trees(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    gender CHAR(1) NOT NULL CHECK (gender IN ('M', 'F')),
    father_id TEXT, -- ID of father in same tree (null for root)
    mother_id TEXT, -- ID of mother (can be wife ID or female person ID)
    union_id TEXT, -- References specific union in the unions table
    birth_order INT NOT NULL DEFAULT 0, -- Preserves book transcription birth order
    notes TEXT,
    branch_meta JSONB,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (tree_id, id)
);

-- 3. Unions / Marriages Table (عقود الزواج والمصاهرات)
CREATE TABLE IF NOT EXISTS public.unions (
    id TEXT NOT NULL, -- e.g. W001 or UUID (scoped to tree_id)
    tree_id UUID NOT NULL REFERENCES public.trees(id) ON DELETE CASCADE,
    husband_id TEXT NOT NULL, -- Person ID of husband
    type TEXT NOT NULL CHECK (type IN ('tree', 'external')),
    -- Internal / Cross-tree link fields
    wife_person_id TEXT, -- ID of female person in tree
    wife_tree_id UUID REFERENCES public.trees(id) ON DELETE SET NULL,
    wife_tree_name TEXT,
    wife_person_name TEXT,
    wife_lineage_label TEXT,
    -- External wife fields
    external_name TEXT,
    external_family TEXT,
    external_tribute TEXT, -- Tribe / Clan / القبيلة والعشيرة
    marriage_order INT NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (tree_id, id)
);

-- 4. Tree Links Table (الروابط والفروع المتصلة بين المشجرات)
CREATE TABLE IF NOT EXISTS public.tree_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    main_tree_id UUID NOT NULL REFERENCES public.trees(id) ON DELETE CASCADE,
    branch_tree_id UUID NOT NULL REFERENCES public.trees(id) ON DELETE CASCADE,
    link_type TEXT NOT NULL CHECK (link_type IN ('daughter-branch', 'brother-branch', 'other')),
    person_id TEXT,
    person_name TEXT,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- Indexes for High Performance Traversals & Lookups
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_persons_tree ON public.persons(tree_id);
CREATE INDEX IF NOT EXISTS idx_persons_father ON public.persons(tree_id, father_id);
CREATE INDEX IF NOT EXISTS idx_persons_mother ON public.persons(tree_id, mother_id);
CREATE INDEX IF NOT EXISTS idx_persons_name ON public.persons(name);

CREATE INDEX IF NOT EXISTS idx_unions_tree ON public.unions(tree_id);
CREATE INDEX IF NOT EXISTS idx_unions_husband ON public.unions(tree_id, husband_id);
CREATE INDEX IF NOT EXISTS idx_unions_wife_person ON public.unions(tree_id, wife_person_id);

CREATE INDEX IF NOT EXISTS idx_tree_links_main ON public.tree_links(main_tree_id);
CREATE INDEX IF NOT EXISTS idx_tree_links_branch ON public.tree_links(branch_tree_id);

-- =============================================================================
-- Row Level Security (RLS) Policies
-- =============================================================================

ALTER TABLE public.trees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tree_links ENABLE ROW LEVEL SECURITY;

-- Allow public read & write (matching current offline/anon setup)
CREATE POLICY "Public trees access" ON public.trees FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public persons access" ON public.persons FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public unions access" ON public.unions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public tree_links access" ON public.tree_links FOR ALL USING (true) WITH CHECK (true);

-- Enable Realtime for multi-user collaboration
ALTER PUBLICATION supabase_realtime ADD TABLE public.trees;
ALTER PUBLICATION supabase_realtime ADD TABLE public.persons;
ALTER PUBLICATION supabase_realtime ADD TABLE public.unions;
