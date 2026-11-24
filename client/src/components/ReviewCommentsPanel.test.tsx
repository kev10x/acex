import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ReviewCommentsPanel from './ReviewCommentsPanel';
import type { ReviewComment } from '../services/api';

const comments: ReviewComment[] = [
  { id: 1, section: 'Chapter 1 › 1.1 Background', page: 3, quote: 'within two years of appointment', comment: 'Cite a source for this figure.', category: 'evidence', severity: 'minor', criterion: null },
  { id: 2, section: 'Chapter 2 Literature review', page: 9, quote: null, comment: 'Synthesise the sources instead of listing them.', category: 'literature', severity: 'major', criterion: 'Literature review' }
];

describe('ReviewCommentsPanel', () => {
  it('shows comments by section with page, quote and severity, and filters to major ones', () => {
    render(<ReviewCommentsPanel comments={comments} />);
    expect(screen.getByText('Detailed comments (2, 1 major)')).toBeTruthy();
    expect(screen.getByText('Chapter 1 › 1.1 Background')).toBeTruthy();
    expect(screen.getByText('“within two years of appointment”')).toBeTruthy();
    expect(screen.getByText('p. 3')).toBeTruthy();
    expect(screen.getByText('Major')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Major only'));
    expect(screen.queryByText('Cite a source for this figure.')).toBeNull();
    expect(screen.getByText('Synthesise the sources instead of listing them.')).toBeTruthy();
  });
});
