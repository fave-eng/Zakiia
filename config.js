window.APP_CONFIG = {
  student: {
    id: "zakiya",
    nameRu: "Закия",
    nameEn: "Zakiya",
    level: "Pre-Intermediate",
    textbook: "Outcomes",
    textbookEdition: "2nd Edition"
  },

  supabase: {
    url: "https://zqzgarvmpqqqaobeicpc.supabase.co",
    anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpxemdhcnZtcHFxcWFvYmVpY3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2ODQwNTIsImV4cCI6MjA5NzI2MDA1Mn0.gARetYwVZfInx3QKS0RvB2I5cOwegPMY5q3nJPX4ZP8",
    authMode: "password",
    tables: {
      homework: "homework_progress",
      vocabulary: "vocabulary_progress",
      vocabularyTopics: "vocabulary_topic_progress",
      grammar: "grammar_progress"
    }
  },

  legacyMigration: {
    enabled: true,
    version: 1,
    supabaseUrl: "https://plkwitrcyoqjwbicdufs.supabase.co",
    anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsa3dpdHJjeW9xandiaWNkdWZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3ODE2MzQsImV4cCI6MjA5NzM1NzYzNH0.KIScrTFu6AntoBS32UuNstJTW_83tHP6iy8srnP9pLU",
    homeworkTable: "homework_results",
    vocabularyTable: "vocab_progress"
  },

  features: {
    homework: true,
    vocabulary: true,
    wordPronunciation: true,
    grammar: true,
    cloudSync: true,
    telegramNotifications: true
  }
};
