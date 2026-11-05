const fields = {
  firstName: ['first name', 'given name', 'fname'],
  lastName: ['last name', 'family name', 'surname', 'lname'],
  fullName: ['full name', 'your name', 'name'],
  preferredName: ['preferred name'],
  email: ['email', 'email address', 'e mail'],
  phone: ['phone', 'phone number', 'telephone', 'mobile phone', 'mobile number'],
  city: ['city'], state: ['state', 'province', 'state province'],
  country: ['country', 'country of residence'], postalCode: ['zip', 'zip code', 'postal code'],
  address: ['address', 'street address', 'address line 1'],
  university: ['school', 'university', 'college university', 'college'],
  degree: ['degree', 'degree type'], major: ['major', 'field of study'],
  graduationDate: ['graduation date', 'expected graduation date'],
  linkedin: ['linkedin', 'linkedin url', 'linkedin profile', 'linkedin profile url'],
  github: ['github', 'github url', 'github profile', 'github profile url'],
  portfolio: ['portfolio', 'portfolio url', 'personal website', 'website', 'website url'],
};
export const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+required$/, '');
const keys = new Map(Object.entries(fields).flatMap(([key, labels]) => labels.map(l => [l, key])));
const autocompleteKeys = { 'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName', nickname: 'preferredName', email: 'email', tel: 'phone', 'address-line1': 'address', 'street-address': 'address', 'address-level2': 'city', 'address-level1': 'state', country: 'country', 'country-name': 'country', 'postal-code': 'postalCode' };
const sensitive = /\b(consent|privacy|terms|certify|certification|attest|acknowledge|signature|disclos\w*|agreement|agree|waiver|background|password|passcode|otp|verification|captcha|security|ssn|social security|tax id|passport|date of birth|birth date|gender|pronouns|race|ethnicity|veteran|disability|demographic|work authori[sz]\w*|authori[sz]ed to work|sponsor\w*|citizen\w*|visa|legally authori[sz]ed|legally entitled|18 years)\b/i;
const extraSensitive = /\b(eligible to work|eligibility to work|right to work|work permit|employment eligibility|birthday|birthdate|criminal|conviction|clearance|bday)\b/i;
export const needsHuman = label => [normalize(label), normalize(String(label).replace(/([a-z])([A-Z])/g, '$1 $2'))].some(text => sensitive.test(text) || extraSensitive.test(text));
export const safeAnswer = v => typeof v === 'boolean' || (typeof v === 'string' && v.trim().length > 0 && v.length <= 5000);

export function resolveAnswer(field, profile, scoped = {}) {
  const question = normalize(field.label);
  if (needsHuman([field.label, field.name, field.placeholder, field.autocomplete, ...(field.context ?? [])].join(' '))) return { reason: 'manual_sensitive' };
  for (const answers of [scoped, profile.customAnswers ?? {}]) {
    const matches = question ? Object.entries(answers).filter(([k]) => normalize(k) === question) : [];
    if (matches.length > 1) return { reason: 'ambiguous_answer' };
    if (matches.length === 1 && safeAnswer(matches[0][1])) return { value: matches[0][1] };
  }
  const labelKey = keys.get(question);
  const autocompleteKey = String(field.autocomplete ?? '').split(/\s+/).map(t => autocompleteKeys[t]).find(Boolean);
  const placeholderKey = !question && keys.get(normalize(field.placeholder));
  if (labelKey && autocompleteKey && labelKey !== autocompleteKey) return { reason: 'ambiguous_answer' };
  const key = labelKey || autocompleteKey || placeholderKey;
  if (!key || (key === 'fullName' && question === 'name' && !autocompleteKey)) return { reason: 'unknown_question' };
  const answers = profile.answers ?? {};
  const value = answers[key] ?? (key === 'fullName' && answers.firstName && answers.lastName ? `${answers.firstName} ${answers.lastName}` : undefined);
  return safeAnswer(value) ? { value } : { reason: 'profile_answer_missing' };
}
