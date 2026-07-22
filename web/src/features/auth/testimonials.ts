// Placeholder testimonials for the auth landing.
//
// These are DELIBERATELY blank templates - not real people, not real quotes.
// Swap in genuine, consented student names and words before this ships to real
// users. Keep the shape the same and the cards lay out unchanged.
//
// Each entry has a short quote, the student's name, and a role line in the shape
// "[Year] - [Course] - [University]". While `placeholder` is true the card shows a
// "Sample" tag so nothing here can be mistaken for a real endorsement. Set
// `placeholder` to false (or drop the field) once a real quote goes in.

export interface Testimonial {
  quote: string;
  name: string;
  role: string;
  placeholder?: boolean;
}

export const testimonials: Testimonial[] = [
  {
    quote:
      'Sample quote - replace me. A line or two on how keeping everything in one place changed the way you revise.',
    name: '[Student name]',
    role: '[Year] - [Course] - [University]',
    placeholder: true,
  },
  {
    quote:
      'Sample quote - replace me. What clicked the first time a messy lecture turned into notes and flashcards.',
    name: '[Student name]',
    role: '[Year] - [Course] - [University]',
    placeholder: true,
  },
  {
    quote:
      'Sample quote - replace me. The moment revision started feeling calmer instead of a last-minute scramble.',
    name: '[Student name]',
    role: '[Year] - [Course] - [University]',
    placeholder: true,
  },
  {
    quote:
      'Sample quote - replace me. Why you would tell a coursemate to give it a try.',
    name: '[Student name]',
    role: '[Year] - [Course] - [University]',
    placeholder: true,
  },
];
