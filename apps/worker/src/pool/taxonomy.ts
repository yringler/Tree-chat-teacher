// The open pool's topic taxonomy (spec §9 "Taxonomy", docs/pool/PLAN.md
// §S8a): a curated two-level tree of learning topics. The request-time
// classifier (pool/tagging.ts) may answer only with a leaf id; anything else
// is rejected and nothing is stored. Aggregation (S8b) counts per leaf with no
// roll-up to parents, so a parent is never named because of its children.
//
// Sensitive roots (health, mental health, sexuality, legal matters, personal
// finances, religious doubt) and every topic under them count toward the
// totals but are never named: a tag on one is stored as the sentinel
// `SENSITIVE_TOPIC_ID`, never the specific id.
//
// To extend it, add a leaf under an existing root (`<root>.<slug>`) or a new
// root with at least one leaf. Ids are permanent: stored tags and review
// decisions refer to them, so retire a topic by leaving it in place. Code, not
// env (§4): re-exported by src/config.ts.

export interface Topic {
  /** `<root>` for a root, `<root>.<slug>` for a leaf; lower-case, `a-z0-9-`. */
  id: string;
  label: string;
  /** The root a leaf belongs to; null for a root. */
  parent: string | null;
  /** Counted in totals but never named publicly (inherited by every child). */
  sensitive?: boolean;
}

/** What a tag on any sensitive topic is stored as. Never a valid topic id. */
export const SENSITIVE_TOPIC_ID = 'sensitive';

interface RootSpec {
  label: string;
  sensitive?: boolean;
  leaves: Record<string, string>;
}

const TREE: Record<string, RootSpec> = {
  history: {
    label: 'History',
    leaves: {
      'ancient-rome': 'Ancient Rome',
      'ancient-greece': 'Ancient Greece',
      'ancient-egypt': 'Ancient Egypt',
      'ancient-near-east': 'Ancient Near East',
      medieval: 'Medieval history',
      'early-modern': 'Early modern history',
      'modern-europe': 'Modern Europe',
      americas: 'History of the Americas',
      asia: 'Asian history',
      africa: 'African history',
      'world-wars': 'The world wars',
      jewish: 'Jewish history',
    },
  },
  science: {
    label: 'Science',
    leaves: {
      physics: 'Physics',
      chemistry: 'Chemistry',
      'organic-chemistry': 'Organic chemistry',
      biology: 'Biology',
      genetics: 'Genetics',
      astronomy: 'Astronomy',
      'earth-science': 'Earth science',
      ecology: 'Ecology',
    },
  },
  math: {
    label: 'Mathematics',
    leaves: {
      arithmetic: 'Arithmetic',
      algebra: 'Algebra',
      geometry: 'Geometry',
      calculus: 'Calculus',
      'linear-algebra': 'Linear algebra',
      statistics: 'Statistics and probability',
      'number-theory': 'Number theory',
      logic: 'Logic and proofs',
    },
  },
  computing: {
    label: 'Computing',
    leaves: {
      programming: 'Programming',
      'web-development': 'Web development',
      algorithms: 'Algorithms and data structures',
      'data-science': 'Data science',
      'machine-learning': 'Machine learning and AI',
      systems: 'Operating systems and networks',
      security: 'Computer security',
    },
  },
  languages: {
    label: 'Languages',
    leaves: {
      english: 'English grammar and usage',
      writing: 'Writing',
      spanish: 'Spanish',
      french: 'French',
      hebrew: 'Hebrew',
      aramaic: 'Aramaic',
      other: 'Other languages',
      linguistics: 'Linguistics',
    },
  },
  literature: {
    label: 'Literature',
    leaves: {
      fiction: 'Fiction',
      poetry: 'Poetry',
      drama: 'Drama',
      criticism: 'Literary criticism',
    },
  },
  philosophy: {
    label: 'Philosophy',
    leaves: {
      ethics: 'Ethics',
      metaphysics: 'Metaphysics',
      epistemology: 'Epistemology',
      political: 'Political philosophy',
      history: 'History of philosophy',
    },
  },
  'jewish-learning': {
    label: 'Jewish learning',
    leaves: {
      tanakh: 'Tanakh',
      talmud: 'Talmud',
      halacha: 'Halacha',
      'jewish-thought': 'Jewish thought',
      chassidut: 'Chassidut',
      liturgy: 'Prayer and liturgy',
    },
  },
  religion: {
    label: 'Religion',
    leaves: {
      comparative: 'Comparative religion',
      christianity: 'Christianity',
      islam: 'Islam',
      'eastern-traditions': 'Eastern traditions',
    },
  },
  arts: {
    label: 'Arts',
    leaves: {
      music: 'Music',
      'visual-arts': 'Visual arts',
      film: 'Film',
      architecture: 'Architecture',
      design: 'Design',
    },
  },
  'social-sciences': {
    label: 'Social sciences',
    leaves: {
      economics: 'Economics',
      psychology: 'Psychology',
      sociology: 'Sociology',
      'political-science': 'Political science',
      anthropology: 'Anthropology',
      geography: 'Geography',
      civics: 'Civics and government',
    },
  },
  business: {
    label: 'Business',
    leaves: {
      entrepreneurship: 'Entrepreneurship',
      marketing: 'Marketing',
      accounting: 'Accounting',
      management: 'Management',
    },
  },
  'practical-skills': {
    label: 'Practical skills',
    leaves: {
      cooking: 'Cooking',
      gardening: 'Gardening',
      'home-repair': 'Home repair',
      crafts: 'Crafts',
      travel: 'Travel',
    },
  },
  games: {
    label: 'Sports and games',
    leaves: {
      sports: 'Sports',
      chess: 'Chess',
      'board-games': 'Board and video games',
    },
  },
  health: {
    label: 'Health',
    sensitive: true,
    leaves: {
      conditions: 'Medical conditions',
      medications: 'Medications',
      nutrition: 'Nutrition',
      fitness: 'Fitness',
      'reproductive-health': 'Reproductive health',
    },
  },
  'mental-health': {
    label: 'Mental health',
    sensitive: true,
    leaves: {
      anxiety: 'Anxiety',
      depression: 'Depression',
      relationships: 'Relationships',
      grief: 'Grief',
      addiction: 'Addiction',
    },
  },
  sexuality: {
    label: 'Sexuality',
    sensitive: true,
    leaves: {
      'sexual-health': 'Sexual health',
      identity: 'Sexual orientation and gender identity',
    },
  },
  legal: {
    label: 'Legal matters',
    sensitive: true,
    leaves: {
      personal: 'Personal legal matters',
      family: 'Family law',
      immigration: 'Immigration',
      employment: 'Employment law',
      criminal: 'Criminal law',
    },
  },
  'personal-finance': {
    label: 'Personal finances',
    sensitive: true,
    leaves: {
      debt: 'Debt',
      budgeting: 'Budgeting',
      taxes: 'Personal taxes',
      investing: 'Investing',
    },
  },
  'religious-doubt': {
    label: 'Religious doubt',
    sensitive: true,
    leaves: {
      'faith-questions': 'Questions of faith',
      'leaving-religion': 'Leaving a religion',
    },
  },
  general: {
    label: 'General',
    leaves: {
      other: 'Other topics',
    },
  },
};

function build(): Topic[] {
  const topics: Topic[] = [];
  for (const [rootId, root] of Object.entries(TREE)) {
    topics.push({
      id: rootId,
      label: root.label,
      parent: null,
      ...(root.sensitive ? { sensitive: true } : {}),
    });
    for (const [slug, label] of Object.entries(root.leaves))
      topics.push({ id: `${rootId}.${slug}`, label, parent: rootId });
  }
  return topics;
}

/** Every topic, roots first in each group. */
export const TOPICS: readonly Topic[] = Object.freeze(build().map((t) => Object.freeze(t)));

const BY_ID: ReadonlyMap<string, Topic> = new Map(TOPICS.map((t) => [t.id, t]));

/** The ids a classifier may answer with: topics no other topic names as its parent. */
export const LEAF_TOPIC_IDS: ReadonlySet<string> = new Set(
  TOPICS.filter((t) => !TOPICS.some((c) => c.parent === t.id)).map((t) => t.id),
);

/** The topic with this id, if any. */
export function topicById(id: string): Topic | undefined {
  return BY_ID.get(id);
}

/** True only for an exact leaf id (no whitespace, no parent, no free text). */
export function isValidLeafTopicId(id: string): boolean {
  return LEAF_TOPIC_IDS.has(id);
}

/** True when the topic or any ancestor is flagged sensitive; the sentinel is sensitive. */
export function isSensitive(id: string): boolean {
  if (id === SENSITIVE_TOPIC_ID) return true;
  for (let t = BY_ID.get(id); t; t = t.parent === null ? undefined : BY_ID.get(t.parent))
    if (t.sensitive) return true;
  return false;
}
