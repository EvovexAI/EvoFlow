import { Card } from '../components/Card';
import { TopFilterBar } from '../components/TopFilterBar';

export function Placeholder({
  title,
  subtitle,
  hint
}: {
  title: string;
  subtitle: string;
  hint: string;
}) {
  return (
    <>
      <TopFilterBar title={title} subtitle={subtitle} />
      <div className="page-grid">
        <Card className="span-3">
          <div className="placeholder-card">
            <div className="placeholder-icon">🚧</div>
            <h3>开发中</h3>
            <p>{hint}</p>
          </div>
        </Card>
      </div>
    </>
  );
}
