import { timelineMilestoneSchema } from './schemas';

export const timeline = [
  timelineMilestoneSchema.parse({
    year: '2024 Q1',
    title: 'Started AI Engineering Journey',
    description: 'Began exploring LLM integration, prompt engineering, and AI-native application patterns.',
  }),
  timelineMilestoneSchema.parse({
    year: '2024 Q3',
    title: 'Built First RAG Application',
    description: 'Developed a retrieval-augmented generation system with vector search and semantic indexing.',
  }),
  timelineMilestoneSchema.parse({
    year: '2025 Q1',
    title: 'Launched Personal AI Platform',
    description: 'Shipped a living interface combining AI chat, agent workflows, and knowledge management.',
  }),
  timelineMilestoneSchema.parse({
    year: '2025 Q3',
    title: 'Open Source Contributions',
    description: 'Released developer tools and shared learnings with the AI engineering community.',
  }),
];
