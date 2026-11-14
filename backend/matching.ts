export type ExperienceUnit = 'days' | 'months' | 'years';

export type MatchJob = {
  trade: string;
  required_skills?: string | string[];
  location?: string;
  min_experience: number;
  min_experience_unit?: ExperienceUnit;
  verification_required: number | boolean;
};

export type MatchFundi = {
  id?: string;
  name?: string;
  role?: string;
  trade?: string;
  skills?: string | string[];
  location?: string;
  experience?: number;
  experience_unit?: ExperienceUnit;
  availability?: string;
  verification_status?: string;
  bio?: string;
  created_at?: string;
};

export const MATCH_WEIGHTS = {
  skills: 30,
  verification: 25,
  experience: 15,
  location: 10,
  availability: 10,
  performance: 10,
} as const;

const DAYS_PER_UNIT: Record<ExperienceUnit, number> = {
  days: 1,
  months: 365 / 12,
  years: 365,
};

export function validExperience(value: unknown, unit: unknown, allowZero = true) {
  const parsedUnit = unit === undefined || unit === '' ? 'years' : unit;
  if (parsedUnit !== 'days' && parsedUnit !== 'months' && parsedUnit !== 'years') return null;
  if (value === undefined || value === '' || value === null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const duration = Number(value);
  const maximum = parsedUnit === 'days' ? 36500 : parsedUnit === 'months' ? 1200 : 100;
  if (!Number.isFinite(duration) || duration < (allowZero ? 0 : Number.MIN_VALUE) || duration > maximum) return null;
  return { value: duration, unit: parsedUnit as ExperienceUnit };
}

export function convertExperience(value: unknown, fromUnit: unknown, toUnit: unknown) {
  const source = validExperience(value, fromUnit, false);
  if (!source || (toUnit !== 'days' && toUnit !== 'months' && toUnit !== 'years')) return null;
  const converted = experienceInDays(source.value, source.unit) / DAYS_PER_UNIT[toUnit];
  const rounded = Number(converted.toPrecision(14));
  return validExperience(rounded, toUnit);
}

export function experienceInDays(value: number, unit: ExperienceUnit = 'years') {
  const duration = Number(value);
  const daysPerUnit = DAYS_PER_UNIT[unit];
  if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(daysPerUnit)) return 0;
  const days = duration * daysPerUnit;
  return Number.isFinite(days) ? days : 0;
}

export function parseSkillList(value: unknown): string[] {
  let skills: unknown = value;
  if (typeof skills === 'string') {
    const original = skills;
    try {
      skills = JSON.parse(skills);
    } catch {
      skills = original.split(',');
    }
    if (!Array.isArray(skills)) skills = original.split(',');
  }
  if (!Array.isArray(skills)) return [];
  const unique = new Map<string, string>();
  for (const skill of skills) {
    if (typeof skill !== 'string') continue;
    const trimmed = skill.trim();
    if (trimmed) unique.set(trimmed.toLowerCase(), trimmed);
  }
  return [...unique.values()];
}

export function match(job: MatchJob, fundi: MatchFundi, averagePerformance?: number) {
  let score = 0;
  const reasons: string[] = [];
  const unmet: string[] = [];
  const normalized = (value: string | undefined) => (value || '').trim().toLowerCase();
  const tradeMatches = normalized(fundi.trade) !== '' && normalized(fundi.trade) === normalized(job.trade);
  if (tradeMatches) reasons.push('Trade matches the job');
  else unmet.push('Trade does not match');

  const requiredSkills = parseSkillList(job.required_skills);
  const candidateSkills = new Set(parseSkillList(fundi.skills).map(normalized));
  const matchedSkills = requiredSkills.filter((skill) => candidateSkills.has(normalized(skill)));
  const skillPoints = requiredSkills.length ? (matchedSkills.length / requiredSkills.length) * MATCH_WEIGHTS.skills : MATCH_WEIGHTS.skills;
  score += skillPoints;
  if (!requiredSkills.length) reasons.push('No specific skills required; full skills points awarded');
  else if (matchedSkills.length === requiredSkills.length) reasons.push('All required skills match');
  else {
    if (matchedSkills.length) reasons.push(`Matched ${matchedSkills.length} of ${requiredSkills.length} required skills`);
    unmet.push(`Missing required skills: ${requiredSkills.filter((skill) => !candidateSkills.has(normalized(skill))).join(', ')}`);
  }

  const fundiExperience = validExperience(fundi.experience, fundi.experience_unit, false);
  const jobExperience = validExperience(job.min_experience, job.min_experience_unit);
  const experienceDays = fundiExperience ? experienceInDays(fundiExperience.value, fundiExperience.unit) : 0;
  const minimumExperienceDays = jobExperience ? experienceInDays(jobExperience.value, jobExperience.unit) : 0;
  const experienceValid = fundiExperience !== null && jobExperience !== null
    && Number.isFinite(experienceDays) && Number.isFinite(minimumExperienceDays);
  const experienceMeetsMinimum = experienceValid && experienceDays >= minimumExperienceDays;
  const experiencePoints = !experienceValid
    ? 0
    : minimumExperienceDays
      ? Math.min(experienceDays / minimumExperienceDays, 1) * MATCH_WEIGHTS.experience
      : MATCH_WEIGHTS.experience;
  score += experiencePoints;
  if (experienceMeetsMinimum) reasons.push('Meets minimum experience');
  else unmet.push(experienceValid ? 'Below required experience' : 'Experience value or unit is invalid');

  if (normalized(fundi.location) && normalized(fundi.location) === normalized(job.location)) {
    score += MATCH_WEIGHTS.location;
    reasons.push('Same working location');
  } else unmet.push('Location does not match');

  const available = normalized(fundi.availability) === 'available';
  if (available) {
    score += MATCH_WEIGHTS.availability;
    reasons.push('Marked as available');
  } else unmet.push('Not marked as available');

  const verified = normalized(fundi.verification_status) === 'verified';
  if (verified) {
    score += MATCH_WEIGHTS.verification;
    reasons.push('Skills evidence verified');
  } else {
    unmet.push('Skills evidence not yet verified');
    if (job.verification_required) unmet.push('Verified fundis are required');
  }

  const hasPerformanceHistory = averagePerformance !== undefined && Number.isFinite(averagePerformance);
  const performanceRating = hasPerformanceHistory ? Math.max(0, Math.min(5, averagePerformance)) : 2.5;
  const performancePoints = performanceRating / 5 * MATCH_WEIGHTS.performance;
  score += performancePoints;
  if (!hasPerformanceHistory) {
    reasons.push('No published performance reviews; neutral 2.5/5 rating used (5/10 points)');
  } else {
    reasons.push(`Average performance rating ${performanceRating.toFixed(1)}/5`);
  }

  const verificationRequired = job.verification_required === 1 || job.verification_required === true;
  const verificationFlagValid = verificationRequired
    || job.verification_required === 0
    || job.verification_required === false;
  const eligible = tradeMatches
    && matchedSkills.length === requiredSkills.length
    && experienceMeetsMinimum
    && verificationFlagValid
    && (!verificationRequired || verified)
    && available;
  const boundedScore = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;

  return {
    fundi: {
      ...fundi,
      experience_unit: fundi.experience_unit || 'years',
      skills: parseSkillList(fundi.skills),
    },
    score: Math.round(boundedScore * 100) / 100,
    reasons,
    unmet: [...new Set(unmet)],
    eligible,
  };
}
