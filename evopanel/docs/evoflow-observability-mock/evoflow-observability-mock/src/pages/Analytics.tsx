import { agents, models, providers, requestTrend } from '../data/mock';
import { Card } from '../components/Card';
import { BarRanking, SmallBars, TokenStackChart } from '../components/Charts';
import { TopFilterBar } from '../components/TopFilterBar';

export function Analytics() {
  const modelRows = models.map((model) => ({ label: model.model, provider: model.provider, value: model.cost, requests: model.requests.toLocaleString(), tokens: model.tokens, cost: `$${model.cost.toFixed(2)}` }));
  return (
    <>
      <TopFilterBar title="成本与趋势 Analytics" subtitle="Token 成本、请求趋势、Agent / Model / Provider 成本排名" />
      <div className="page-grid">
        <Card className="mini-stat"><span>总成本</span><strong>$186.42</strong><em>7d</em></Card>
        <Card className="mini-stat"><span>日均成本</span><strong>$26.63</strong><em>avg/day</em></Card>
        <Card className="mini-stat"><span>单请求成本</span><strong>$0.00145</strong><em>avg/request</em></Card>
        <Card className="mini-stat"><span>Token 单价估算</span><strong>$4.35/M</strong><em>weighted</em></Card>

        <Card title="成本趋势" subtitle="Cost Trend" className="span-2">
          <TokenStackChart data={requestTrend} />
        </Card>
        <Card title="Provider 成本排名" subtitle="Cost by Provider">
          <SmallBars rows={providers.map((provider) => ({ label: provider.name, value: Math.round(provider.cost * 100), sub: `$${provider.cost.toFixed(2)}` }))} />
        </Card>
        <Card title="Model 成本排名" subtitle="Cost by Model" className="span-2">
          <BarRanking rows={modelRows} />
        </Card>
        <Card title="Agent 成本估算" subtitle="Estimated Cost by Agent">
          <SmallBars rows={agents.map((agent, index) => ({ label: agent.name, value: Math.round((agents.length - index) * 1200), sub: agent.mainModel }))} />
        </Card>
      </div>
    </>
  );
}
