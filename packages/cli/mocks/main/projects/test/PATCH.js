import { expect } from 'vitest';

const defaultSettings = {
  allowed_ips: {
    ips: ['192.168.1.1'],
    protected_branches_only: false,
  },
};

export default function (req, res) {
  const project = req.body.project ?? {};
  if (project.settings?.enable_logical_replication !== undefined) {
    expect(project.settings.enable_logical_replication).toBe(true);
  }
  res.send({
    project: {
      id: 'test',
      name: project.name ?? 'test_project',
      created_at: '2019-01-01T00:00:00Z',
      settings: { ...defaultSettings, ...project.settings },
    },
  });
}
