import { createContent } from '@endless/content';
import lexiconText from '../../../lab/data/lexicon/a1_a2.yaml?raw';

export const content = createContent(lexiconText);
export const library = content.pilot;
