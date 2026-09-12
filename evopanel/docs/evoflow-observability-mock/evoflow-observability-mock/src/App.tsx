import { useMemo, useState } from 'react';
import type { NavKey } from './types';
import { Shell } from './components/Shell';
import { Dashboard } from './pages/Dashboard';
import { Requests } from './pages/Requests';
import { Agents } from './pages/Agents';
import { Models } from './pages/Models';
import { Tools } from './pages/Tools';
import { Gateway } from './pages/Gateway';
import { Trace } from './pages/Trace';
import { Analytics } from './pages/Analytics';
import { EvalDashboard } from './pages/EvalDashboard';
import { EvalBusiness } from './pages/EvalBusiness';
import { EvalSecurity } from './pages/EvalSecurity';
import { EvalPerformance } from './pages/EvalPerformance';
import { EvalHistory } from './pages/EvalHistory';
import { EvalSchedule } from './pages/EvalSchedule';
import { EvalAlert } from './pages/EvalAlert';
import { Settings } from './pages/Settings';

function App() {
  const [active, setActive] = useState<NavKey>('dashboard');
  const page = useMemo(() => {
    switch (active) {
      case 'dashboard': return <Dashboard />;
      case 'requests': return <Requests />;
      case 'agents': return <Agents />;
      case 'models': return <Models />;
      case 'tools': return <Tools />;
      case 'gateway': return <Gateway />;
      case 'trace': return <Trace />;
      case 'analytics': return <Analytics />;
      case 'eval-dashboard': return <EvalDashboard />;
      case 'eval-business': return <EvalBusiness />;
      case 'eval-security': return <EvalSecurity />;
      case 'eval-performance': return <EvalPerformance />;
      case 'eval-history': return <EvalHistory />;
      case 'eval-schedule': return <EvalSchedule />;
      case 'eval-alert': return <EvalAlert />;
      case 'settings': return <Settings />;
      default: return <Dashboard />;
    }
  }, [active]);

  return <Shell active={active} onChange={setActive}>{page}</Shell>;
}

export default App;
