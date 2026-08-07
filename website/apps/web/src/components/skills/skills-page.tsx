"use client";

import Link from "next/link";
import { skillsPageByLocale, type SkillsPageCopy } from "@ai-site/content";
import { useCallback, useState, type ReactNode } from "react";
import { useLocalizedValue } from "../locale-provider";
import styles from "./skills-page.module.css";

const SCENARIO_ICONS: Record<SkillsPageCopy["scenarios"]["items"][number]["icon"], ReactNode> = {
  research: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  code: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="m8 9-4 3 4 3" />
      <path d="m16 9 4 3-4 3" />
      <path d="m13 5-2 14" />
    </svg>
  ),
  media: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="m10 9 5 3-5 3V9Z" fill="currentColor" stroke="none" />
    </svg>
  ),
  content: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M5 5h14v14H5z" />
      <path d="M8 9h8M8 12h8M8 15h5" />
    </svg>
  ),
  desktop: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  ),
  knowledge: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M5 5v14l7-3 7 3V5l-7 3-7-3Z" />
    </svg>
  ),
};

function CopyButton({
  text,
  copyLabel,
  copiedLabel,
  className,
}: {
  text: string;
  copyLabel: string;
  copiedLabel: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  }, [text]);
  return (
    <button type="button" className={className} onClick={onCopy}>
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}

function CopyIconButton({ text, label }: { text: string; label: string }) {
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  }, [text]);
  return (
    <button type="button" className={styles.copyIcon} onClick={onCopy} aria-label={label}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="8" y="8" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      </svg>
    </button>
  );
}

export function SkillsPage() {
  const copy = useLocalizedValue(skillsPageByLocale);
  const [stepIndex, setStepIndex] = useState(0);
  const [optionIndex, setOptionIndex] = useState(0);
  const [openFaq, setOpenFaq] = useState<Set<number>>(
    () => new Set(copy.faq.items.map((_, i) => i)),
  );

  const step = copy.quickStart.steps[stepIndex];
  const option = step.options?.[optionIndex];

  const toggleFaq = (i: number) => {
    setOpenFaq((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.container}>
            <div className={styles.badge}>{copy.hero.badge}</div>
            <h1 className={styles.h1}>
              <span className={styles.h1Line}>{copy.hero.titleLine1}</span>
              <strong className={styles.h1Accent}>{copy.hero.titleLine2}</strong>
            </h1>
            <p className={styles.lead}>{copy.hero.lead}</p>
            <div className={styles.heroCtas}>
              <Link className={styles.btnGhost} href={copy.hero.guideCta.href}>
                {copy.hero.guideCta.label}
              </Link>
              <a className={styles.btnPrimary} href={copy.hero.installCta.href}>
                {copy.hero.installCta.label}
              </a>
            </div>
          </div>
        </section>

        <section className={styles.agents}>
          <div className={styles.container}>
            <h2 className={styles.h2Sm}>{copy.agents.heading}</h2>
            <ul className={styles.agentGrid}>
              {copy.agents.items.map((item) => (
                <li key={item.name} className={styles.agentItem}>
                  <div className={styles.agentIcon} style={{ color: item.color }}>
                    <span style={{ background: item.color }}>{item.initial}</span>
                  </div>
                  <span>{item.name}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className={styles.section} id="start">
          <div className={styles.container}>
            <div className={styles.sectionHeadWide}>
              <h2 className={styles.h2}>{copy.quickStart.heading}</h2>
              <div className={styles.prereqPanel}>
                <div className={styles.prereqLabel}>
                  {copy.quickStart.prereqLabel.length === 4 ? (
                    <>
                      {copy.quickStart.prereqLabel.slice(0, 2)}
                      <br />
                      {copy.quickStart.prereqLabel.slice(2)}
                    </>
                  ) : (
                    copy.quickStart.prereqLabel
                  )}
                </div>
                <ol className={styles.prereqList}>
                  {copy.quickStart.prerequisites.map((item) => (
                    <li key={item.text}>
                      {item.linkLabel && item.linkHref ? (
                        <>
                          {item.text} <Link href={item.linkHref}>{item.linkLabel}</Link>
                        </>
                      ) : (
                        item.text
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            <div className={styles.processLayout}>
              <div className={styles.processRail} aria-label="install steps">
                {copy.quickStart.steps.map((s, i) => (
                  <button
                    key={s.title}
                    type="button"
                    className={`${styles.processStep} ${i === stepIndex ? styles.processStepActive : ""}`}
                    aria-current={i === stepIndex ? "step" : undefined}
                    onClick={() => {
                      setStepIndex(i);
                      setOptionIndex(0);
                    }}
                  >
                    <span className={styles.processStepIndex}>{i + 1}</span>
                    <span className={styles.processStepCopy}>
                      <strong>{s.title}</strong>
                      <span>{s.subtitle}</span>
                    </span>
                  </button>
                ))}
              </div>

              <article className={styles.processPanel}>
                <div className={styles.processPanelStep}>{step.panelStep}</div>
                <h3>{step.panelTitle}</h3>
                <p>{step.panelBody}</p>

                {step.options ? (
                  <>
                    <div className={styles.processOptions}>
                      {step.options.map((opt, i) => (
                        <button
                          key={opt.label}
                          type="button"
                          className={`${styles.processOption} ${i === optionIndex ? styles.processOptionActive : ""}`}
                          onClick={() => setOptionIndex(i)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    {option ? (
                      <div className={styles.processOptionBody}>
                        <p>{option.body}</p>
                        {option.prompt ? (
                          <div className={styles.promptBox}>
                            <code>{option.prompt}</code>
                            <CopyButton
                              text={option.prompt}
                              copyLabel={copy.quickStart.copyLabel}
                              copiedLabel={copy.quickStart.copiedLabel}
                              className={styles.copyCmd}
                            />
                          </div>
                        ) : null}
                        {option.hint ? <p className={styles.hint}>{option.hint}</p> : null}
                      </div>
                    ) : null}
                  </>
                ) : null}

                {step.bullets ? (
                  <ol className={styles.bulletList}>
                    {step.bullets.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ol>
                ) : null}
              </article>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.sectionMuted}`} id="cases">
          <div className={styles.container}>
            <div className={styles.sectionHead}>
              <h2 className={styles.h2}>{copy.scenarios.heading}</h2>
              <p>{copy.scenarios.lead}</p>
            </div>
            <div className={styles.scenarioGrid}>
              {copy.scenarios.items.map((item) => (
                <article key={item.title} className={styles.scenarioCard}>
                  <span className={styles.scenarioIcon} aria-hidden>
                    {SCENARIO_ICONS[item.icon]}
                  </span>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                  <div className={styles.scenarioPrompt}>
                    <div className={styles.scenarioPromptHead}>
                      <span>{copy.scenarios.promptLabel}</span>
                      <CopyIconButton text={item.prompt} label={copy.quickStart.copyLabel} />
                    </div>
                    <code>{item.prompt}</code>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.section} id="capabilities">
          <div className={styles.container}>
            <div className={styles.sectionHead}>
              <h2 className={styles.h2}>{copy.capabilities.heading}</h2>
              <p>{copy.capabilities.lead}</p>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {copy.capabilities.columns.map((col) => (
                      <th key={col}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {copy.capabilities.rows.map((row) => (
                    <tr key={row[0]}>
                      <td>{row[0]}</td>
                      <td>{row[1]}</td>
                      <td>{row[2]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.sectionMuted}`} id="faq">
          <div className={styles.container}>
            <div className={styles.sectionHead}>
              <h2 className={styles.h2}>{copy.faq.heading}</h2>
              <p>{copy.faq.lead}</p>
            </div>
            <div className={styles.faqList}>
              {copy.faq.items.map((item, i) => {
                const open = openFaq.has(i);
                return (
                  <article key={item.question} className={`${styles.faqItem} ${open ? styles.faqOpen : ""}`}>
                    <button
                      type="button"
                      className={styles.faqQuestion}
                      aria-expanded={open}
                      onClick={() => toggleFaq(i)}
                    >
                      <span>{item.question}</span>
                      <svg className={styles.faqIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                    {open ? (
                      <div className={styles.faqAnswer}>
                        {Array.isArray(item.answer) ? (
                          <ol>
                            {item.answer.map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ol>
                        ) : (
                          <p>{item.answer}</p>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <div className={styles.community}>
          <div>
            <h2 className={styles.h2Sm}>{copy.community.heading}</h2>
            <p className={styles.communityLead}>{copy.community.lead}</p>
          </div>
          <a
            className={styles.btnPrimary}
            href={copy.community.ctaHref}
            rel="noreferrer"
            target="_blank"
          >
            {copy.community.ctaLabel}
          </a>
        </div>
      </main>
    </div>
  );
}
