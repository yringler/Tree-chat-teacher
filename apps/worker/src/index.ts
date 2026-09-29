export default {
  async fetch(): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  },
} satisfies ExportedHandler<Env>;

export class TreeSession {}
