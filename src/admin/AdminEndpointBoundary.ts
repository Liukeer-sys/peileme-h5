export const isCurrentAdminEndpoint = (
  activeEndpoint: string,
  capturedEndpoint: string
) =>
  Boolean(capturedEndpoint) && activeEndpoint === capturedEndpoint;
