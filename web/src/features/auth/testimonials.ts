// Testimonials for the auth landing.
//
// These are FABRICATED sample quotes, kept only so the section is not empty before real
// ones exist. Every entry has `placeholder: true`, which renders a visible "Sample" tag on
// its card - so nothing here is presented to real users as a genuine endorsement. Replace
// each with a real, consented student quote/name/degree and set `placeholder: false` (or drop
// the field) to remove the tag. Hyphens only, no en/em dashes.

export interface Testimonial {
  quote: string;
  name: string;
  role: string;
  placeholder?: boolean;
}

export const testimonials: Testimonial[] = [
  {
    quote:
      'I used to keep notes in five different apps. Now everything for my degree lives in one place and revision finally feels manageable.',
    name: 'Maya Ellis',
    role: '2nd year - BSc Biomedical Science - University of Leeds',
    placeholder: true,
  },
  {
    quote:
      'Dropping in a lecture recording and getting the slides and notes back saves me hours every single week.',
    name: 'Tom Whitfield',
    role: '3rd year - MEng Mechanical Engineering - University of Bristol',
    placeholder: true,
  },
  {
    quote:
      'The flashcards pull straight from my own notes, so revision stopped being a separate chore I kept putting off.',
    name: 'Priya Nair',
    role: '1st year - LLB Law - University of Manchester',
    placeholder: true,
  },
  {
    quote:
      'Linking topics together made my chemistry notes click in a way a folder full of documents never did.',
    name: 'Callum Fraser',
    role: '2nd year - BSc Chemistry - University of Edinburgh',
    placeholder: true,
  },
];
